"""Local secret storage for AI provider API keys (BYOK).

Backends, picked automatically:
- macOS Keychain via the `security` CLI (service "healmedaily-ai", one item
  per provider) when running on Darwin with `security` available.
- Fallback: JSON file at {repo}/data/secrets/ai-keys.json created 0o600
  (data/ is gitignored).

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
    return platform.system() == "Darwin" and shutil.which("security") is not None


def _keys_path():
    return SECRETS_DIR / _KEYS_FILENAME


def _read_file_store() -> dict[str, str]:
    path = _keys_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_file_store(store: dict[str, str]) -> None:
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
