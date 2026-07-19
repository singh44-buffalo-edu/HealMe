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
- Token valid but the caller is not the owner → 403 (see below).
- Medplum unreachable during verification → 502 (never silently allow).

`AI_REQUIRE_AUTH=false` turns the gate off for fully-loopback dev setups;
the default is ON.

Owner authorization (confused-deputy fix): the gate AUTHENTICATES (the caller
holds a live Medplum session) and, when `AI_OWNER_PROFILES` is set, also
AUTHORIZES — the caller's userinfo profile (fhirUser / profile / sub claim)
must be on that allowlist. This matters because the service then acts with
its OWN full-access client credentials: without an owner check, a care-circle
member (Phase 9) holding a deliberately-scoped Medplum token could call the
ai-service directly and reach whole-record export/review, bypassing their
AccessPolicy. Set `AI_OWNER_PROFILES` to the owner's profile reference(s)
(comma-separated, e.g. `Practitioner/abc,Patient/xyz`) before exposing the
service to anyone but the owner. When it is UNSET the gate authenticates only
(any valid session passes) — the safe default for the current single-user
deployment, so nothing breaks until care-circle is actually wired.
"""

from __future__ import annotations

import hashlib
import time
from urllib.parse import urljoin

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse

from .config import settings

#: Paths that stay reachable without a Medplum session:
#: - /health: liveness only.
#: - /push/dispatch: called by the Medplum server's Subscription rest-hook,
#:   not a user; it authenticates with the push shared secret instead
#:   (push.py _authorize_subscription), so the session gate must not block it.
EXEMPT_PATHS = frozenset({"/health", "/push/dispatch"})

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


def _owner_allowlist() -> set[str]:
    """Normalized {Type/id} owner profile references from AI_OWNER_PROFILES.
    Empty set ⇒ authenticate-only (any valid session passes)."""
    return {_normalize_ref(p) for p in settings.ai_owner_profiles.split(",") if p.strip()}


def _normalize_ref(reference: str) -> str:
    """A profile reference or fhirUser URL → bare 'Type/id'
    (e.g. 'https://host/fhir/R4/Practitioner/abc' → 'Practitioner/abc')."""
    ref = reference.strip().rstrip("/")
    parts = ref.split("/")
    return "/".join(parts[-2:]) if len(parts) >= 2 else ref


def _claim_profiles(claims: dict) -> set[str]:
    """Every profile-ish identity claim userinfo might carry, normalized."""
    out: set[str] = set()
    for key in ("fhirUser", "profile", "sub"):
        value = claims.get(key)
        if isinstance(value, str) and value:
            out.add(_normalize_ref(value))
        elif isinstance(value, dict) and isinstance(value.get("reference"), str):
            out.add(_normalize_ref(value["reference"]))
    return out


async def _userinfo(token: str) -> dict | None:
    """OIDC userinfo claims for a live token, or None for a definitive
    invalid (400/401/403). Raises httpx.HTTPError when Medplum cannot give a
    verdict (network OR 5xx) so the caller maps it to 502 — never a false
    'sign in again' during a Medplum hiccup.
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
        try:
            claims = response.json()
        except ValueError:
            claims = {}
        return claims if isinstance(claims, dict) else {}
    if response.status_code in (400, 401, 403):
        return None
    # 5xx / 429 / anything unexpected: not an authorization verdict.
    raise httpx.HTTPError(f"userinfo returned {response.status_code}")


async def require_medplum_token(request: Request, call_next):
    """HTTP middleware: gate every non-exempt request on a Medplum session
    (and, when AI_OWNER_PROFILES is set, on being the owner)."""
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
            claims = await _userinfo(token)
        except httpx.HTTPError:
            return JSONResponse(
                status_code=502,
                content={"detail": "Could not verify the session with Medplum."},
            )
        if claims is None:
            _verified.pop(key, None)
            return JSONResponse(
                status_code=401,
                content={"detail": "Session expired or invalid — sign in again."},
            )
        allowlist = _owner_allowlist()
        if allowlist and allowlist.isdisjoint(_claim_profiles(claims)):
            # Authenticated but not the owner — do NOT cache (a scoped token
            # must never earn a fast-path), and never say why beyond "not
            # authorized".
            _verified.pop(key, None)
            return JSONResponse(
                status_code=403,
                content={"detail": "This account is not authorized for the AI service."},
            )
        _prune(now)
        _verified[key] = now + CACHE_TTL_SECONDS

    return await call_next(request)
