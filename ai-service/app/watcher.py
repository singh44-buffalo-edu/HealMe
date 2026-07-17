"""Watched-folder auto-import: drop files into data/inbox and they are
ingested on a schedule — PDFs/photos through the document pipeline (review
queue), structured exports (FHIR JSON / CSV / Apple Health XML) through the
deterministic importers. Files move to processed/ or failed/ afterwards so a
crash can never ingest twice.

Runs as an asyncio task started by main.lifespan (every INGEST_SCAN_SECONDS);
POST /ingest/scan-now triggers one scan on demand. Routing by file extension
only (STRUCTURED/DOCUMENTS below) — the safety split is preserved: documents
still land in the review queue, structured files still commit with dedup.
Belt-and-braces idempotency: even if a processed file were re-dropped, the
importers' content-hash identifiers make the re-run a no-op."""

from __future__ import annotations

import asyncio
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

from . import importers, ingest
from .config import REPO_ROOT, settings
from .medplum import medplum

# .xml defaults to Apple Health; run_import sniffs ClinicalDocument roots and reroutes to ccda.
STRUCTURED = {".json": "fhir", ".csv": "csv", ".xml": "apple", ".cda": "ccda", ".ccda": "ccda", ".hl7": "hl7"}
DOCUMENTS = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}

# Serializes scans: the background loop and an on-demand POST /ingest/scan-now
# (or two scan-now calls) must never process the same inbox concurrently, or a
# file could be read+ingested twice before either scan renames it out.
_scan_lock = threading.Lock()

# A file whose mtime changed within this many seconds is assumed to still be
# copying in (Finder/cp/unzip/AirDrop grow the final name progressively) and is
# skipped until the next scan — a quiescence guard against reading a partial file.
QUIESCENCE_SECONDS = 5


def inbox_dir() -> Path:
    """INGEST_WATCH_DIR as an absolute path (relative values anchor to
    REPO_ROOT — which is "/" inside the container, see config.py)."""
    raw = Path(settings.ingest_watch_dir)
    return raw if raw.is_absolute() else (REPO_ROOT / raw).resolve()


def scan_once() -> list[dict]:
    """Process every new file in the inbox exactly once. Returns a summary
    per file. Scans are serialized (_scan_lock): a scan already in progress
    makes a concurrent call a no-op rather than double-processing files. One
    bad file is archived to failed/ and never stops the rest of the scan."""
    results: list[dict] = []
    # Silent no-op until Medplum + patient are configured — the loop starts at
    # boot, before `make seed` may have run.
    if not medplum.configured or not settings.medplum_patient_id:
        return results
    # Non-blocking: if another scan holds the lock, skip this round entirely.
    if not _scan_lock.acquire(blocking=False):
        return results
    try:
        return _scan_locked()
    finally:
        _scan_lock.release()


def _scan_locked() -> list[dict]:
    """The scan body; runs only while _scan_lock is held (see scan_once)."""
    results: list[dict] = []
    inbox = inbox_dir()
    processed = inbox / "processed"
    failed = inbox / "failed"
    for folder in (inbox, processed, failed):
        folder.mkdir(parents=True, exist_ok=True)

    now_ts = time.time()
    for path in sorted(inbox.iterdir()):
        # Skip non-files, dotfiles, and symlinks (a symlink dropped in the inbox
        # would otherwise leak an arbitrary file's contents into the record).
        if path.is_symlink() or not path.is_file() or path.name.startswith("."):
            continue
        # Quiescence: skip a file that was modified moments ago — it may still
        # be copying in. It gets picked up on the next scan once stable.
        try:
            if now_ts - path.stat().st_mtime < QUIESCENCE_SECONDS:
                continue
        except OSError:
            continue
        suffix = path.suffix.lower()
        # Timestamp prefix keeps archive names unique when the same filename
        # is dropped repeatedly.
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        claimed = processed / f"{stamp}-{path.name}"
        try:
            data = path.read_bytes()
            if suffix in STRUCTURED:
                summary = importers.run_import(medplum, STRUCTURED[suffix], data, settings.medplum_patient_id)
            elif suffix in DOCUMENTS:
                summary = ingest.ingest_document(
                    medplum, data, DOCUMENTS[suffix], path.name, settings.medplum_patient_id
                )
            else:
                raise ValueError(f"unsupported file type '{suffix}'")
            path.rename(claimed)
            results.append({"file": path.name, "ok": True, "summary": summary})
            print(f"[watcher] imported {path.name}: {summary}")
        except Exception as err:  # noqa: BLE001 — one bad file must not stop the scan
            try:
                path.rename(failed / f"{stamp}-{path.name}")
            except OSError:
                pass
            results.append({"file": path.name, "ok": False, "error": str(err)})
            print(f"[watcher] FAILED {path.name}: {err}")
            traceback.print_exc()
    return results


async def watch_loop() -> None:
    """Forever-loop for main.lifespan: scan_once (in a worker thread — it does
    blocking file + HTTP I/O) every interval; survives any exception. The 5 s
    floor guards against a misconfigured zero/negative interval busy-looping."""
    interval = max(settings.ingest_scan_seconds, 5)
    print(f"[watcher] watching {inbox_dir()} every {interval}s")
    while True:
        try:
            await asyncio.to_thread(scan_once)
        except Exception:  # noqa: BLE001 — the loop must survive anything
            traceback.print_exc()
        await asyncio.sleep(interval)
