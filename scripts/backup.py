#!/usr/bin/env python
"""Timestamped local backup of the Medplum stack (Phase 9 hardening).

Backs up, into data/backups/<timestamp>/ (gitignored via data/):
  1. medplum-db.sql       — full pg_dump of the Postgres CDR (--clean --if-exists)
  2. binary-storage.tar   — the server's file binary storage (uploaded documents)

Both are taken via `docker compose exec` against the running stack, so no
extra tools are needed on the host. Run with `make backup`.

Together those two artifacts ARE the whole record: all FHIR resources live in
Postgres (no side database — CLAUDE.md §2) and uploaded originals/generated
PDFs live in the file binary store. Deliberately NOT included: .env (admin
password, client secret) and data/secrets/ (BYOK AI keys) — keys never ride
along with the health record (FHIR-MAPPING.md §11). Restore steps are printed
at the end of every run.

Caveat: pg_dump runs while the server is live (consistent snapshot, but
in-flight writes may miss it); for a guaranteed-quiescent dump stop the
server first: `docker compose -f infra/docker-compose.yml stop medplum-server`.

No scheduling is built in — suggested cron for nightly backups:
  0 2 * * * cd <repo> && make backup >> data/backups/backup.log 2>&1
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
COMPOSE = ["docker", "compose", "-f", str(REPO / "infra" / "docker-compose.yml")]


def log(msg: str) -> None:
    print(f"[backup] {msg}")


def die(msg: str) -> None:
    print(f"[backup] FATAL: {msg}", file=sys.stderr)
    sys.exit(1)


def default_backup_dir() -> Path:
    """HMD_BACKUP_DIR from the environment or .env (parsed by hand — this
    script has no third-party deps), else data/backups. Relative paths anchor
    at the repo root so cron's cwd doesn't matter."""
    configured = os.environ.get("HMD_BACKUP_DIR", "")
    if not configured:
        env_path = REPO / ".env"
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                stripped = line.strip()
                if stripped.startswith("HMD_BACKUP_DIR="):
                    configured = stripped.split("=", 1)[1].strip()
                    break
    path = Path(configured) if configured else REPO / "data" / "backups"
    return path if path.is_absolute() else REPO / path


def run_to_file(cmd: list[str], out_file: Path, what: str) -> None:
    """Stream a compose-exec command's stdout into out_file. On failure the
    partial file is deleted before dying — a truncated dump must never be
    mistaken for a good backup."""
    log(
        f"dumping {what} -> {out_file.relative_to(REPO) if out_file.is_relative_to(REPO) else out_file}"
    )
    with out_file.open("wb") as fh:
        try:
            subprocess.run(cmd, stdout=fh, check=True)
        except FileNotFoundError:
            die("docker not found — is Docker Desktop installed and on PATH?")
        except subprocess.CalledProcessError as exc:
            out_file.unlink(missing_ok=True)
            die(f"{what} failed (exit {exc.returncode}) — is the stack up? (`make up`)")


def main() -> None:
    """Dump the CDR + binary store into a fresh timestamped directory and
    print the matching restore instructions."""
    parser = argparse.ArgumentParser(
        prog="backup.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="backup root (default: HMD_BACKUP_DIR from .env, else data/backups)",
    )
    args = parser.parse_args()

    root = Path(args.output_dir).resolve() if args.output_dir else default_backup_dir()
    stamp = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    dest = root / stamp
    dest.mkdir(parents=True, exist_ok=True)

    # 1. Postgres: the entire CDR (all FHIR resources live here — no side DB).
    db_file = dest / "medplum-db.sql"
    run_to_file(
        COMPOSE
        + [
            "exec",
            "-T",
            "postgres",
            "pg_dump",
            "-U",
            "medplum",
            "--clean",
            "--if-exists",
            "medplum",
        ],
        db_file,
        "Postgres CDR",
    )

    # 2. Binary storage (MEDPLUM_BINARY_STORAGE=file:./binary/ inside the
    # server container — uploaded PDFs/photos and generated reports).
    tar_file = dest / "binary-storage.tar"
    probe = subprocess.run(
        COMPOSE + ["exec", "-T", "medplum-server", "test", "-d", "binary"],
        capture_output=True,
    )
    if probe.returncode == 0:
        run_to_file(
            COMPOSE + ["exec", "-T", "medplum-server", "tar", "-cf", "-", "binary"],
            tar_file,
            "binary storage",
        )
    else:
        log(
            "no binary storage directory yet (no uploads) — skipping binary-storage.tar"
        )

    log(f"backup complete: {dest}")
    for f in sorted(dest.iterdir()):
        log(f"  {f.name}  {f.stat().st_size:,} bytes")

    compose = "docker compose -f infra/docker-compose.yml"
    print(
        f"""
Restore instructions (run from the repo root):
  1. Start only the database:      {compose} up -d postgres
  2. Restore the CDR:              cat '{db_file}' | {compose} exec -T postgres psql -U medplum medplum
  3. Start the rest of the stack:  make up
  4. Restore binary storage:       cat '{tar_file}' | {compose} exec -T medplum-server tar -xf -
     (skip if binary-storage.tar was not created)
  5. Verify:                       make smoke
Secrets note: .env (tokens, admin password) is NOT part of this backup — keep
your own copy of .env somewhere safe; the FHIR record never contains keys.
"""
    )


if __name__ == "__main__":
    main()
