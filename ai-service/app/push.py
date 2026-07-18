"""Push endpoints (/push): device registration + the Subscription dispatcher.

Two trust models on purpose:
- /push/register, /push/unregister — called by the signed-in app, so they
  ride the normal Medplum-session gate (auth.py) like every other endpoint.
- /push/dispatch — called by the MEDPLUM SERVER's Subscription rest-hook, not
  a user, so it is exempt from the session gate (auth.py EXEMPT_PATHS) and
  instead authenticated by a shared secret the Subscription sends in its
  Authorization header (PUSH_SUBSCRIPTION_SECRET). Without the secret it 401s.

PHI rule (CLAUDE.md §6): the dispatcher receives a CommunicationRequest whose
payload contains the medication name — it deliberately IGNORES that text and
sends a GENERIC notification ("You have a reminder") plus a screen target for
deep-linking. No medication name, no resource id, nothing clinical ever
reaches the notification payload or APNs.
"""

from __future__ import annotations

import hmac
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from . import apns, pushstore
from .config import settings

router = APIRouter(prefix="/push", tags=["push"])

CS_MEDIUM = "https://healmedaily.local/fhir/CodeSystem/communication-medium"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# --- Device registration (session-gated) -----------------------------------


class PushRegistration(BaseModel):
    device_token: str
    # 'sandbox' for development builds, 'production' for TestFlight/App Store.
    environment: str = "production"


@router.post("/register")
def register(reg: PushRegistration) -> dict:
    """Register/refresh this device's APNs token. Dedups by token."""
    token = reg.device_token.strip()
    if not token:
        raise HTTPException(status_code=400, detail="device_token is required")
    pushstore.register_token(token, reg.environment, _now_iso())
    return {"registered": True, "push_configured": apns.configured()}


class PushUnregister(BaseModel):
    device_token: str


@router.post("/unregister")
def unregister(body: PushUnregister) -> dict:
    """Drop this device's token (sign-out / push disabled). Idempotent.
    Token in the body, never the URL, so it stays out of access logs."""
    pushstore.remove_token(body.device_token.strip())
    return {"unregistered": True}


# --- Subscription dispatcher (shared-secret authenticated, gate-exempt) -----


def _authorize_subscription(authorization: str | None) -> None:
    """Constant-time check of the Subscription's shared secret. A missing
    server-side secret means dispatch is not wired — refuse rather than accept
    an unauthenticated caller."""
    expected = settings.push_subscription_secret.strip()
    if not expected:
        raise HTTPException(status_code=503, detail="push dispatch is not configured")
    presented = ""
    if authorization and authorization.lower().startswith("bearer "):
        presented = authorization[7:].strip()
    if not presented or not hmac.compare_digest(presented, expected):
        raise HTTPException(status_code=401, detail="invalid subscription secret")


def _is_push_medium(resource: dict[str, Any]) -> bool:
    for medium in resource.get("medium", []) or []:
        for coding in medium.get("coding", []) or []:
            if coding.get("system") == CS_MEDIUM and coding.get("code") == "push":
                return True
    return False


def _deep_link_target(resource: dict[str, Any]) -> tuple[str, str]:
    """Map a CommunicationRequest to a (kind, screen) for the app to route on.
    Coarse + non-clinical: 'dose-reminder' → the Today dose panel. Anything
    else falls back to Today. Never derived from the (PHI) payload text."""
    for about in resource.get("about", []) or []:
        ref = about.get("reference", "")
        if ref.startswith("MedicationRequest/"):
            return ("dose-reminder", "today")
    return ("reminder", "today")


@router.post("/dispatch")
async def dispatch(request: Request, authorization: str | None = Header(default=None)) -> dict:
    """Medplum Subscription rest-hook target. Receives one active
    CommunicationRequest; fans a GENERIC push out to every registered device.

    Always returns 200 with a status summary (even 'not configured' /
    'skipped') so a working Subscription is not driven into retry storms by a
    non-error condition. Genuine auth failures still 401/503."""
    _authorize_subscription(authorization)

    try:
        resource = await request.json()
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="expected a FHIR resource body")
    if not isinstance(resource, dict) or resource.get("resourceType") != "CommunicationRequest":
        # Criteria should prevent this; tolerate it without erroring the sub.
        return {"sent": 0, "skipped": "not a CommunicationRequest"}
    if resource.get("status") != "active" or not _is_push_medium(resource):
        return {"sent": 0, "skipped": "not an active push CommunicationRequest"}

    cr_id = resource.get("id") or ""
    if cr_id and pushstore.already_delivered(cr_id):
        return {"sent": 0, "skipped": "already delivered"}

    if not apns.configured():
        # The app works without push — say so, don't crash the Subscription.
        return {"sent": 0, "skipped": "APNs not configured"}

    kind, target = _deep_link_target(resource)
    tokens = pushstore.all_tokens()
    sent = 0
    pruned = 0
    for device_token, info in list(tokens.items()):
        try:
            result = await apns.send(
                device_token=device_token,
                environment=info.get("environment", "production"),
                title="HealMeDaily",
                # Generic on purpose — the med name stays out of the payload.
                body="You have a health reminder.",
                data={"target": target, "kind": kind},
            )
        except apns.APNsError:
            # A signing/transport failure hits every token equally — stop and
            # let the next Subscription fire (or a later reminder) retry.
            break
        if result.ok:
            sent += 1
        elif result.should_prune:
            pushstore.remove_token(device_token)
            pruned += 1

    if sent > 0 and cr_id:
        pushstore.mark_delivered(cr_id, _now_iso())
    return {"sent": sent, "pruned": pruned, "devices": len(tokens)}
