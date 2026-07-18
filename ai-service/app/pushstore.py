"""Local store for APNs device tokens + a delivery-dedup ledger.

Device push tokens are not clinical data, but they ARE sensitive — anyone
holding one can push to the owner's phone — so they live in data/secrets
(0600, gitignored), exactly like the BYOK API keys (keystore.py): out of
FHIR, out of every record export/backup, out of git. They are deliberately
NOT modeled as a FHIR resource for that reason.

Two collections in one file:
- `tokens`: {device_token: {environment, updated_at}} — the fan-out set the
  dispatcher pushes to. Keyed by the token so re-registration dedups.
- `delivered`: {communication_request_id: iso_ts} — a small ledger so a
  Subscription that fires (or retries) more than once for the same reminder
  pushes at most once. This keeps the push path from having to mutate FHIR
  clinical state (completing CommunicationRequests) just to be idempotent.

Nothing here is ever logged.
"""

from __future__ import annotations

import json
import os

from .config import REPO_ROOT

SECRETS_DIR = REPO_ROOT / "data" / "secrets"
_FILENAME = "push-tokens.json"
# Cap the dedup ledger so it cannot grow without bound; oldest entries drop.
_MAX_DELIVERED = 500


def _path():
    # Function, not constant, so tests can monkeypatch SECRETS_DIR.
    return SECRETS_DIR / _FILENAME


def _read() -> dict:
    path = _path()
    if not path.exists():
        return {"tokens": {}, "delivered": {}}
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {"tokens": {}, "delivered": {}}
    if not isinstance(data, dict):
        return {"tokens": {}, "delivered": {}}
    data.setdefault("tokens", {})
    data.setdefault("delivered", {})
    return data


def _write(store: dict) -> None:
    """0600 at creation (not chmod-after-write) so token bytes are never
    briefly world-readable; directory tightened to 0700."""
    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(SECRETS_DIR, 0o700)
    except OSError:
        pass
    fd = os.open(_path(), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(store, fh, indent=1)
    try:
        os.chmod(_path(), 0o600)
    except OSError:
        pass


# --- Device tokens ---------------------------------------------------------


def register_token(device_token: str, environment: str, now_iso: str) -> None:
    """Add/refresh one device token. `environment` is 'sandbox' or
    'production' (which APNs host to use for this token)."""
    device_token = device_token.strip()
    if not device_token:
        raise ValueError("device_token must be non-empty")
    env = "sandbox" if environment.strip().lower() == "sandbox" else "production"
    store = _read()
    store["tokens"][device_token] = {"environment": env, "updated_at": now_iso}
    _write(store)


def remove_token(device_token: str) -> None:
    """Idempotent unregister (sign-out / disable, or an APNs 410/400 prune)."""
    store = _read()
    if store["tokens"].pop(device_token.strip(), None) is not None:
        _write(store)


def all_tokens() -> dict[str, dict]:
    """{device_token: {environment, updated_at}} — the current fan-out set."""
    return _read()["tokens"]


# --- Delivery dedup --------------------------------------------------------


def already_delivered(communication_request_id: str) -> bool:
    return communication_request_id in _read()["delivered"]


def mark_delivered(communication_request_id: str, now_iso: str) -> None:
    store = _read()
    delivered = store["delivered"]
    delivered[communication_request_id] = now_iso
    if len(delivered) > _MAX_DELIVERED:
        # Drop the oldest by timestamp — the ledger only guards against a
        # near-term duplicate fire, not forever.
        for key in sorted(delivered, key=lambda k: delivered[k])[: len(delivered) - _MAX_DELIVERED]:
            del delivered[key]
    store["delivered"] = delivered
    _write(store)
