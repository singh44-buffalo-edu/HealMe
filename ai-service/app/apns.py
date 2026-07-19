"""APNs (Apple Push Notification service) sender — token-based auth.

Server-only: the APNs signing key (.p8), key id, team id and topic are the
owner's secrets and live in config/.env, NEVER in the app (a public client
must not carry them). The app just registers its device token; this module
does the privileged send.

Auth is the modern provider-token flow: an ES256 JWT signed with the .p8 key,
reused for ~50 min (APNs rejects tokens older than 1 h). Transport is HTTP/2
to api.push.apple.com (or the sandbox host), required by APNs — hence the
`h2` dependency behind httpx's http2=True.

The service must boot and run with NO APNs config (the app works without
push, CLAUDE.md §6): `configured` is False and `send` reports "not
configured" instead of raising.

PHI: this module never receives clinical content. Callers pass a generic
title/body and a small data dict (a screen target); see push.py, which
deliberately drops the reminder's med-name payload.
"""

from __future__ import annotations

import base64
import json
import time

import httpx

from .config import settings

_APNS_HOSTS = {
    "production": "https://api.push.apple.com",
    "sandbox": "https://api.sandbox.push.apple.com",
}

# Cached provider JWT: (token, issued_at_epoch). Refreshed well inside APNs's
# 1-hour ceiling.
_jwt_cache: tuple[str, float] | None = None
_JWT_TTL_SECONDS = 3000  # 50 min


class APNsError(Exception):
    """Send failed for a reason worth surfacing (config/transport)."""


def configured() -> bool:
    """True when every piece needed to sign + address a push is present."""
    return bool(settings.apns_key_id and settings.apns_team_id and settings.apns_bundle_id and _load_private_key_pem())


def _load_private_key_pem() -> str | None:
    """The .p8 private key PEM, from APNS_KEY_P8 (inline PEM) or the file at
    APNS_KEY_PATH. None when neither is set/readable."""
    inline = settings.apns_key_p8.strip()
    if inline:
        # Allow a literal "\n"-escaped single-line env value.
        return inline.replace("\\n", "\n")
    path = settings.apns_key_path.strip()
    if path:
        try:
            with open(path, encoding="utf-8") as fh:
                return fh.read()
        except OSError:
            return None
    return None


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _provider_token() -> str:
    """A cached ES256 provider JWT (header kid=key-id, claims iss=team-id,
    iat=now). Signed with the .p8 EC key via `cryptography` — no PyJWT dep."""
    global _jwt_cache
    now = time.time()
    if _jwt_cache and now - _jwt_cache[1] < _JWT_TTL_SECONDS:
        return _jwt_cache[0]

    # Imported lazily so the service still starts if `cryptography` is absent
    # and push is simply never configured.
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec, utils
    from cryptography.hazmat.primitives.serialization import load_pem_private_key

    pem = _load_private_key_pem()
    if not pem:
        raise APNsError("APNs signing key is not configured")
    # A malformed / wrong-curve .p8 must surface as an APNsError (which
    # dispatch handles as a graceful skip) — NEVER an uncaught ValueError/
    # OverflowError that would 500 the gate-exempt /push/dispatch and drive
    # the Medplum Subscription into a retry storm.
    try:
        key = load_pem_private_key(pem.encode("utf-8"), password=None)
        if not isinstance(key, ec.EllipticCurvePrivateKey):
            raise APNsError("APNs key is not an EC private key (.p8 expected)")
        if key.curve.name != "secp256r1":
            raise APNsError("APNs key must be a P-256 EC key (ES256)")
        header = {"alg": "ES256", "kid": settings.apns_key_id}
        claims = {"iss": settings.apns_team_id, "iat": int(now)}
        signing_input = f"{_b64url(json.dumps(header).encode())}.{_b64url(json.dumps(claims).encode())}"
        der = key.sign(signing_input.encode("ascii"), ec.ECDSA(hashes.SHA256()))
        # APNs wants the raw R||S pair (64 bytes), not DER.
        r, s = utils.decode_dss_signature(der)
        raw_sig = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    except APNsError:
        raise
    except Exception as err:  # noqa: BLE001 — any crypto failure ⇒ not configured, not a 500
        raise APNsError("APNs signing key is invalid") from err
    token = f"{signing_input}.{_b64url(raw_sig)}"
    _jwt_cache = (token, now)
    return token


def reset_token_cache() -> None:
    """Drop the cached provider JWT (tests; key rotation)."""
    global _jwt_cache
    _jwt_cache = None


class SendResult:
    """Per-token outcome the caller uses to prune dead tokens."""

    def __init__(self, ok: bool, status: int, should_prune: bool, reason: str = ""):
        self.ok = ok
        self.status = status
        self.should_prune = should_prune
        self.reason = reason


async def send(
    device_token: str,
    environment: str,
    title: str,
    body: str,
    data: dict,
) -> SendResult:
    """Send one alert push. `data` is merged into the APNs payload alongside
    `aps` for the app to read on tap (screen target only — never PHI).

    Returns a SendResult; a 410 (Unregistered) or 400 BadDeviceToken sets
    should_prune so the caller drops the token. Raises APNsError only for a
    configuration/transport failure that affects every token equally.
    """
    if not configured():
        raise APNsError("not configured")
    host = _APNS_HOSTS.get(environment, _APNS_HOSTS["production"])
    url = f"{host}/3/device/{device_token}"
    payload = {"aps": {"alert": {"title": title, "body": body}, "sound": "default"}, **data}
    headers = {
        "authorization": f"bearer {_provider_token()}",
        "apns-topic": settings.apns_bundle_id,
        "apns-push-type": "alert",
    }
    try:
        async with httpx.AsyncClient(http2=True, timeout=10.0) as client:
            response = await client.post(url, headers=headers, content=json.dumps(payload).encode())
    except httpx.HTTPError as err:
        raise APNsError(f"APNs transport error: {err}") from err

    if response.status_code == 200:
        return SendResult(ok=True, status=200, should_prune=False)
    reason = ""
    try:
        reason = response.json().get("reason", "")
    except (ValueError, json.JSONDecodeError):
        reason = response.text[:120]
    # A token APNs no longer accepts should be dropped, not retried forever.
    prune = response.status_code == 410 or reason in {"BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"}
    return SendResult(ok=False, status=response.status_code, should_prune=prune, reason=reason)
