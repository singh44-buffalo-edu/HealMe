"""Watched-folder auto-import: drop files into data/inbox and they are
ingested on a schedule — PDFs/photos through the document pipeline (review
queue), structured exports (FHIR JSON / CSV / Apple Health XML) through the
deterministic importers. Files move to processed/ or failed/ afterwards so a
crash can never ingest twice."""

from __future__ import annotations

import asyncio
import traceback
from datetime import datetime, timezone
from pathlib import Path

from . import importers, ingest
from .config import REPO_ROOT, settings
from .medplum import medplum

STRUCTURED = {".json": "fhir", ".csv": "csv", ".xml": "apple"}
DOCUMENTS = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}


def inbox_dir() -> Path:
    raw = Path(settings.ingest_watch_dir)
    return raw if raw.is_absolute() else (REPO_ROOT / raw).resolve()


def scan_once() -> list[dict]:
    """Process every new file in the inbox exactly once. Returns a summary
    per file; safe to call concurrently with uploads (files are moved out of
    the inbox before processing results are written anywhere)."""
    results: list[dict] = []
    if not medplum.configured or not settings.medplum_patient_id:
        return results
    inbox = inbox_dir()
    processed = inbox / "processed"
    failed = inbox / "failed"
    for folder in (inbox, processed, failed):
        folder.mkdir(parents=True, exist_ok=True)

    for path in sorted(inbox.iterdir()):
        if not path.is_file() or path.name.startswith("."):
            continue
        suffix = path.suffix.lower()
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
    interval = max(settings.ingest_scan_seconds, 5)
    print(f"[watcher] watching {inbox_dir()} every {interval}s")
    while True:
        try:
            await asyncio.to_thread(scan_once)
        except Exception:  # noqa: BLE001 — the loop must survive anything
            traceback.print_exc()
        await asyncio.sleep(interval)
