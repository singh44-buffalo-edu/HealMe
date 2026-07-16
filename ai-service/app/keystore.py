"""Local secret storage for AI provider API keys (BYOK).

Consumed by providers.resolve_key (KeyStore beats the .env fallback) and the
/ai/keys endpoints in ai_settings.py. Backends, picked automatically per call:
- macOS Keychain via the `security` CLI (service "healmedaily-ai", one item
  per provider) when running on Darwin with `security` available.
- Fallback: JSON file at {repo}/data/secrets/ai-keys.json created 0o600
  (data/ is gitignored). This is the backend inside the Docker container
  (no Keychain there); compose bind-mounts data/secrets so host and container
  share the same keys.

WHY KEYS ARE NEVER STORED IN FHIR (FHIR-MAPPING §11): the record is designed
to be exported, backed up, and shared (export.py full-record bundle,
scripts/backup.py, care-circle read access). A key stored as any FHIR resource
would ride along with every one of those flows. Keeping keys in the OS
keychain / a 0600 local file keeps them out of the record, out of git, and out
of every export — same reason they are kept out of .env dumps and logs.

Keys are never logged and never returned unmasked by any endpoint — callers
that need to display a key use mask().
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess

from .config import REPO_ROOT

SERVICE_NAME = "healmedaily-ai"
SECRETS_DIR = REPO_ROOT / "data" / "secrets"
_KEYS_FILENAME = "ai-keys.json"


def _use_keychain() -> bool:
    """Backend switch, evaluated per call (tests monkeypatch this to force the
    file backend and stay away from the real Keychain)."""
    return platform.system() == "Darwin" and shutil.which("security") is not None


def _keys_path():
    # Function (not constant) so tests can monkeypatch SECRETS_DIR.
    return SECRETS_DIR / _KEYS_FILENAME


def _read_file_store() -> dict[str, str]:
    """File-backend read: {provider: key}. Any unreadable/corrupt file degrades
    to "no keys stored" rather than crashing key resolution."""
    path = _keys_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_file_store(store: dict[str, str]) -> None:
    """File-backend write. The file is opened with mode 0o600 at creation (not
    chmod-after-write) so the key bytes are never world-readable, even briefly;
    the directory is tightened to 0o700."""
    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(SECRETS_DIR, 0o700)
    except OSError:
        pass
    fd = os.open(_keys_path(), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(store, fh, indent=1)
    try:
        os.chmod(_keys_path(), 0o600)  # tighten a pre-existing wider file
    except OSError:
        pass


def get_key(provider: str) -> str | None:
    """The stored key for a provider name, or None. Never raises — a missing
    Keychain item or unreadable file simply means "not configured"."""
    provider = provider.strip().lower()
    if _use_keychain():
        result = subprocess.run(
            ["security", "find-generic-password", "-s", SERVICE_NAME, "-a", provider, "-w"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            return None
        return result.stdout.strip() or None
    return _read_file_store().get(provider) or None


def set_key(provider: str, key: str) -> None:
    """Store/overwrite a provider key (`security -U` updates in place; the file
    backend rewrites the whole store). Raises on Keychain write failure with a
    message that deliberately excludes the key and stderr."""
    provider = provider.strip().lower()
    key = key.strip()
    if not provider or not key:
        raise ValueError("provider and key must be non-empty")
    if _use_keychain():
        result = subprocess.run(
            ["security", "add-generic-password", "-U", "-s", SERVICE_NAME, "-a", provider, "-w", key],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            # Never echo stderr wholesale — keep the key out of any error path.
            raise RuntimeError(f"macOS Keychain write failed (security exited {result.returncode})")
        return
    store = _read_file_store()
    store[provider] = key
    _write_file_store(store)


def delete_key(provider: str) -> None:
    """Remove a stored key. Idempotent — deleting an absent key is a no-op
    (note: an .env fallback key may still make the provider "configured")."""
    provider = provider.strip().lower()
    if _use_keychain():
        subprocess.run(
            ["security", "delete-generic-password", "-s", SERVICE_NAME, "-a", provider],
            capture_output=True,
            check=False,  # absent item is fine — delete is idempotent
        )
        return
    store = _read_file_store()
    if provider in store:
        del store[provider]
        _write_file_store(store)


def mask(key: str) -> str:
    """'sk-ant-api03-...wxyz' → 'sk-…wxyz'. Safe for display; never reversible."""
    key = key.strip()
    if not key:
        return ""
    if len(key) <= 8:
        return "…" + key[-2:]
    return f"{key[:3]}…{key[-4:]}"
