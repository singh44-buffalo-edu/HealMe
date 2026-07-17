"""Bearer-token gate for the ai-service HTTP surface.

Every endpoint except /health requires a valid Medplum access token
(Authorization: Bearer …). The service holds PHI-shaped powers — whole-record
export, review-queue approval, AI settings — so once it is reachable from
anything beyond loopback (a phone on the LAN, a cloud deployment), an
unauthenticated surface would be an open door to the record. Callers that
already talk to Medplum (the React frontend, the iOS app, smoke tests using
client credentials) simply forward the token they hold; the service verifies
it against Medplum's OIDC userinfo endpoint and caches the positive result
briefly so hot paths do not add a round trip per request.

Fail-closed rules:
- No/malformed Authorization header → 401 (except /health and CORS
  preflights).
- Medplum says the token is invalid → 401.
- Medplum unreachable during verification → 502 (never silently allow).

`AI_REQUIRE_AUTH=false` turns the gate off for fully-loopback dev setups;
the default is ON.

Scope limitation (documented, not yet closed): this gate AUTHENTICATES (the
caller holds a live Medplum session) but does not AUTHORIZE per-caller — the
service then acts with its OWN full-access client credentials. In the
single-user owner app that is the whole intent. But once care-circle members
exist (Phase 9), a member with a deliberately-scoped Medplum token could call
the ai-service directly and reach whole-record export/review, bypassing their
AccessPolicy (a classic confused-deputy). Before exposing the ai-service to
anyone but the owner, add an owner-identity check here (compare the userinfo
profile against the configured owner) or have the service forward the
caller's token for FHIR reads instead of its own. Tracked for Phase 9.
"""

from __future__ import annotations

import hashlib
import time
from urllib.parse import urljoin

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse

from .config import settings

#: Paths that stay reachable without a session: liveness only.
EXEMPT_PATHS = frozenset({"/health"})

#: Positive-verification cache TTL. Short on purpose: a revoked token stays
#: usable here for at most this long.
CACHE_TTL_SECONDS = 300.0

#: sha256(token) -> monotonic expiry. Tokens themselves are never stored.
_verified: dict[str, float] = {}


def _cache_key(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _prune(now: float) -> None:
    if len(_verified) > 512:
        for key, expiry in list(_verified.items()):
            if expiry <= now:
                del _verified[key]


async def _token_is_valid(token: str) -> bool:
    """Ask Medplum whether this access token is live (OIDC userinfo).

    Returns True/False for a definitive answer (200 = valid; 400/401/403 =
    invalid). Raises httpx.HTTPError when Medplum cannot give one — a network
    failure OR a 5xx — so the caller maps it to 502 rather than mistaking an
    outage for an expired session (fail-closed, but never a false "sign in
    again" during a Medplum hiccup).
    """
    # Normalize exactly like medplum.py: urljoin against a base WITHOUT a
    # trailing slash would drop the host's path (or the host itself for a
    # path-less base). Force the trailing slash first.
    base = settings.medplum_base_url
    if not base.endswith("/"):
        base += "/"
    url = urljoin(base, "oauth2/userinfo")
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.get(url, headers={"Authorization": f"Bearer {token}"})
    if response.status_code == 200:
        return True
    if response.status_code in (400, 401, 403):
        return False
    # 5xx / 429 / anything unexpected: not an authorization verdict.
    raise httpx.HTTPError(f"userinfo returned {response.status_code}")


async def require_medplum_token(request: Request, call_next):
    """HTTP middleware: gate every non-exempt request on a Medplum session."""
    if not settings.ai_require_auth:
        return await call_next(request)
    # CORS preflights carry no Authorization header by design.
    if request.method == "OPTIONS" or request.url.path in EXEMPT_PATHS:
        return await call_next(request)

    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        return JSONResponse(
            status_code=401,
            content={"detail": "Sign in required — send your Medplum session token."},
        )
    token = header[7:].strip()
    if not token:
        return JSONResponse(status_code=401, content={"detail": "Empty bearer token."})

    key = _cache_key(token)
    now = time.monotonic()
    if _verified.get(key, 0.0) <= now:
        try:
            valid = await _token_is_valid(token)
        except httpx.HTTPError:
            return JSONResponse(
                status_code=502,
                content={"detail": "Could not verify the session with Medplum."},
            )
        if not valid:
            _verified.pop(key, None)
            return JSONResponse(
                status_code=401,
                content={"detail": "Session expired or invalid — sign in again."},
            )
        _prune(now)
        _verified[key] = now + CACHE_TTL_SECONDS

    return await call_next(request)
