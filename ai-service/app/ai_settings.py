"""Per-feature AI routing, BYOK key endpoints and the privacy-boundary ledger.

Routing model: each AI feature (FEATURES below) routes independently to
"local" (Ollama — data never leaves this machine), "cloud" (the single
globally-chosen cloud provider: exactly one of anthropic/openai/gemini is the
cloud choice at a time) or "off". Per-provider model-name overrides sit
alongside. Everything persists in {repo}/data/secrets/ai-settings.json
(0o600, gitignored). While that file is absent, the legacy AI_PROVIDER env
var drives everything — backward compat with the pre-Phase-7 setup
(AI_PROVIDER=ollama means route all features local).

CONTAINER QUIRK: inside the Docker image REPO_ROOT resolves to "/" (see
config.py), so SETTINGS_FILE becomes /data/secrets/ai-settings.json —
docker-compose bind-mounts the repo's data/secrets there, which is how the
containerized service and the host share one AI configuration (`make
prod-up`, CLAUDE.md §7 phase 9 note).

Other modules import get_provider_for(feature) — the ONLY sanctioned way to
obtain a provider for a routed feature. BOUNDARY-LEDGER REQUIREMENT: every
request whose data leaves this device must be preceded by an AuditEvent via
log_boundary_event — call sites check provider.is_local and write the event
BEFORE the provider call, so the ledger can never miss a disclosure because
a call failed midway (FHIR-MAPPING §11; the Privacy Vault UI is a search
over these events).

API keys are never logged and never returned unmasked by any endpoint
(see keystore.py for storage and the why-not-FHIR rationale).
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import fhir_consts as fc
from . import keystore, providers
from .config import REPO_ROOT, settings
from .providers import ProviderError, ProviderNotConfigured, _BaseProvider

# The routable AI features. Adding one here automatically gives it a routing
# row in AI Settings; its call site must use get_provider_for + the boundary
# ledger discipline described in the module docstring.
FEATURES = ("health-review", "ingest-extraction", "assistant", "nl-import", "feeling")
ROUTES = ("local", "cloud", "off")
CLOUD_PROVIDERS = ("anthropic", "openai", "gemini")
ALL_PROVIDERS = CLOUD_PROVIDERS + ("ollama",)

# See module docstring: resolves to /data/secrets/... inside the container.
SETTINGS_FILE = REPO_ROOT / "data" / "secrets" / "ai-settings.json"


# --- Persistence --------------------------------------------------------------


def _load() -> dict[str, Any] | None:
    """Raw settings file dict, or None when absent/corrupt (None = fall back to
    the legacy env semantics in _effective)."""
    if not SETTINGS_FILE.exists():
        return None
    try:
        data = json.loads(SETTINGS_FILE.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _save(data: dict[str, Any]) -> None:
    """Persist settings with the same 0o600/0o700 discipline as the keystore
    (the file names which provider gets health data — private, not secret)."""
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(SETTINGS_FILE.parent, 0o700)
    except OSError:
        pass
    fd = os.open(SETTINGS_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(data, fh, indent=1)
    try:
        os.chmod(SETTINGS_FILE, 0o600)
    except OSError:
        pass


def _effective() -> dict[str, Any]:
    """Routing/cloud-provider/models with the settings file taking precedence;
    absent file falls back to the legacy AI_PROVIDER env semantics. Unknown
    features default to "cloud"; an invalid stored cloud provider degrades to
    None (→ ProviderNotConfigured downstream) rather than erroring here."""
    data = _load()
    if data is not None:
        stored_routing = data.get("routing") or {}
        routing = {feature: stored_routing.get(feature, "cloud") for feature in FEATURES}
        cloud = data.get("cloud_provider") or settings.ai_provider.strip().lower() or None
        if cloud not in CLOUD_PROVIDERS:
            cloud = None
        models = {k: v for k, v in (data.get("models") or {}).items() if k in ALL_PROVIDERS and v}
        base_urls = {k: v for k, v in (data.get("base_urls") or {}).items() if k in ALL_PROVIDERS and v}
        return {
            "routing": routing,
            "cloud_provider": cloud,
            "models": models,
            "base_urls": base_urls,
            "from_file": True,
        }
    env_name = settings.ai_provider.strip().lower()
    if env_name == "ollama":
        return {
            "routing": dict.fromkeys(FEATURES, "local"),
            "cloud_provider": None,
            "models": {},
            "base_urls": {},
            "from_file": False,
        }
    return {
        "routing": dict.fromkeys(FEATURES, "cloud"),
        "cloud_provider": env_name or None,
        "models": {},
        "base_urls": {},
        "from_file": False,
    }


def default_provider_spec() -> tuple[str, str | None, str | None]:
    """(name, model, base_url) for feature-less legacy callers
    (providers.get_provider)."""
    eff = _effective()
    if eff["from_file"]:
        name = eff["cloud_provider"] or ""
        return name, eff["models"].get(name), eff["base_urls"].get(name)
    return settings.ai_provider.strip().lower(), None, None


def get_provider_for(feature: str) -> _BaseProvider:
    """The feature-aware entry point other modules import. Returns a Provider
    instance or raises ProviderNotConfigured (routed off / nothing configured).
    Raising happens before any data is assembled or sent — the "never send data
    to an unconfigured provider" guardrail (CLAUDE.md §6). Callers must then
    check provider.is_local and write the boundary AuditEvent before calling
    generate* on a cloud provider."""
    if feature not in FEATURES:
        raise ValueError(f"unknown AI feature '{feature}' — one of {', '.join(FEATURES)}")
    eff = _effective()
    route = eff["routing"][feature]
    if route == "off":
        raise ProviderNotConfigured(f"AI is turned off for '{feature}' — enable it in AI Settings")
    if route == "local":
        return providers.build_provider("ollama", model=eff["models"].get("ollama"))
    name = eff["cloud_provider"]
    if not name:
        raise ProviderNotConfigured(
            "No AI provider configured — pick one in AI Settings or set AI_PROVIDER in .env (AI features are optional)"
        )
    return providers.build_provider(name, model=eff["models"].get(name), base_url=eff["base_urls"].get(name))


# --- Privacy-boundary ledger ---------------------------------------------------


def log_boundary_event(
    medplum: Any,
    feature: str,
    provider_name: str,
    description: str,
    endpoint_host: str | None = None,
) -> dict[str, Any]:
    """One AuditEvent per AI request whose data leaves this device — the
    cloud-boundary ledger (FHIR-MAPPING §11). Call sites invoke this for cloud
    providers only (skip when provider.is_local), and MUST call it BEFORE the
    provider request: the ledger records intent-to-disclose, so a call that
    fails after data was sent still has its ledger entry. `description` is a
    short human line for the Privacy Vault UI (truncated to 200 chars) —
    metadata only, never record content.

    `endpoint_host` names the egress host when a provider is pointed at a
    NON-default endpoint (a custom OpenAI-compatible gateway) — it is folded
    into the human description so the ledger discloses exactly where data went.
    It is a hostname only, never a secret. When None (the well-known default
    host) the description keeps its exact legacy format below.

    Machine-readable identity: type = local {CS_AUDIT}|cloud-egress with
    subtype = the feature slug, so the ledger is one server-side token search
    (AuditEvent?type=...|cloud-egress) instead of a regex over descriptions.
    HistoryPage.tsx keys on exactly this coding — the two must stay in
    lockstep. The human entity.description keeps its exact legacy format:
    pre-coding events are still recognized by it, and it names the provider."""
    provider_label = f"{provider_name} ({endpoint_host})" if endpoint_host else provider_name
    event = {
        "resourceType": "AuditEvent",
        "type": {"system": fc.CS_AUDIT, "code": "cloud-egress", "display": "Data left this device (cloud AI)"},
        "subtype": [{"system": fc.CS_AUDIT, "code": feature}],
        "action": "E",
        "recorded": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "outcome": "0",
        "agent": [{"name": "healmedaily-ai", "requestor": True}],
        "source": {"observer": {"display": "healmedaily-ai"}},
        "entity": [
            {
                "name": str(description)[:200],
                "description": f"AI request · {feature} → {provider_label} · data left this device",
            }
        ],
    }
    return medplum.create(event)


# --- Router --------------------------------------------------------------------

router = APIRouter(prefix="/ai", tags=["ai"])


class SettingsUpdate(BaseModel):
    """Partial update — any omitted (None) field keeps its current value."""

    routing: dict[str, str] | None = None
    cloud_provider: str | None = None
    models: dict[str, str] | None = None
    # Per-provider endpoint override (custom OpenAI-compatible gateways). Keyed
    # by provider name; only 'openai' is honored at present. Not a secret.
    base_urls: dict[str, str] | None = None


class KeyBody(BaseModel):
    key: str


def _validated_provider(name: str, allow_local: bool) -> str:
    """Normalize/validate a provider path segment; allow_local=False rejects
    ollama for key endpoints (the local provider has no API key)."""
    name = name.strip().lower()
    if name == "ollama" and not allow_local:
        raise HTTPException(status_code=400, detail="ollama is the local provider — it needs no API key")
    if name not in ALL_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"unknown provider '{name}' — one of {', '.join(ALL_PROVIDERS)}")
    return name


def _settings_payload() -> dict[str, Any]:
    """The AI Settings page payload: per-provider configured state (masked key
    only, never the key itself), effective routing and cloud choice."""
    eff = _effective()
    provider_list = []
    for name in ALL_PROVIDERS:
        is_local = name == "ollama"
        key = None if is_local else providers.resolve_key(name)  # key presence only — no network call
        entry: dict[str, Any] = {
            "name": name,
            "is_local": is_local,
            "configured": True if is_local else bool(key),
            "model": eff["models"].get(name) or providers.resolve_model(name),
        }
        if key:
            entry["masked_key"] = keystore.mask(key)
        if is_local:
            entry["base_url"] = settings.ollama_base_url
        elif name == "openai":
            # Effective endpoint (never a secret): settings-file override >
            # OPENAI_BASE_URL env > default. Lets the UI show/edit the custom
            # OpenAI-compatible gateway.
            entry["base_url"] = (
                eff["base_urls"].get("openai") or settings.openai_base_url or providers.DEFAULT_OPENAI_BASE_URL
            )
        provider_list.append(entry)
    return {"providers": provider_list, "routing": eff["routing"], "cloud_provider": eff["cloud_provider"]}


@router.get("/settings")
def get_settings() -> dict[str, Any]:
    """Current effective AI configuration (read-only, no network calls)."""
    return _settings_payload()


@router.put("/settings")
def update_settings(body: SettingsUpdate) -> dict[str, Any]:
    """Merge a partial update into the effective settings and persist the whole
    result. First write materializes ai-settings.json, permanently switching
    the service off the legacy AI_PROVIDER env semantics. Validation is all-or-
    nothing: any bad feature/route/provider 400s before anything is saved."""
    eff = _effective()
    stored = _load() or {}

    routing = dict(eff["routing"])
    if body.routing is not None:
        for feature, route in body.routing.items():
            if feature not in FEATURES:
                raise HTTPException(
                    status_code=400, detail=f"unknown feature '{feature}' — one of {', '.join(FEATURES)}"
                )
            if route not in ROUTES:
                raise HTTPException(status_code=400, detail=f"route for '{feature}' must be one of {', '.join(ROUTES)}")
            routing[feature] = route

    cloud = eff["cloud_provider"]
    if body.cloud_provider is not None:
        name = body.cloud_provider.strip().lower()
        if name not in CLOUD_PROVIDERS:
            raise HTTPException(
                status_code=400,
                detail=f"cloud_provider must be one of {', '.join(CLOUD_PROVIDERS)} (ollama is 'local')",
            )
        cloud = name

    models = {k: v for k, v in (stored.get("models") or {}).items() if k in ALL_PROVIDERS}
    if body.models is not None:
        for name, model in body.models.items():
            if name not in ALL_PROVIDERS:
                raise HTTPException(status_code=400, detail=f"unknown provider '{name}' in models")
            if model and model.strip():
                models[name] = model.strip()
            else:
                models.pop(name, None)  # empty string clears the override

    base_urls = {k: v for k, v in (stored.get("base_urls") or {}).items() if k in ALL_PROVIDERS}
    if body.base_urls is not None:
        # Validate every entry BEFORE mutating (all-or-nothing, matches the
        # rest of this handler). Unknown provider → 400. Only http(s) URLs, and
        # cleartext http:// is allowed ONLY for loopback — a remote http host
        # would send record contents (PHI) unencrypted over the network.
        for name, url in body.base_urls.items():
            if name not in ALL_PROVIDERS:
                raise HTTPException(status_code=400, detail=f"unknown provider '{name}' in base_urls")
            trimmed = (url or "").strip()
            if not trimmed:
                continue
            parts = urlsplit(trimmed)
            if parts.scheme not in ("http", "https") or not parts.netloc:
                raise HTTPException(
                    status_code=400,
                    detail=f"base_url for '{name}' must be an http:// or https:// URL",
                )
            if parts.scheme == "http" and (parts.hostname or "").lower() not in ("localhost", "127.0.0.1", "::1"):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"base_url for '{name}' must use https:// for non-local hosts "
                        "(http:// is allowed only for localhost)"
                    ),
                )
        for name, url in body.base_urls.items():
            trimmed = (url or "").strip()
            if trimmed:
                base_urls[name] = trimmed
            else:
                base_urls.pop(name, None)  # empty string clears the override

    _save({"routing": routing, "cloud_provider": cloud, "models": models, "base_urls": base_urls})
    return _settings_payload()


@router.post("/keys/{provider_name}")
def set_provider_key(provider_name: str, body: KeyBody) -> dict[str, Any]:
    """Store a BYOK key in the keystore (Keychain / 0600 file — never FHIR,
    never .env). Response echoes only the masked form."""
    name = _validated_provider(provider_name, allow_local=False)
    key = body.key.strip()
    if not key:
        raise HTTPException(status_code=400, detail="key must not be empty")
    keystore.set_key(name, key)
    return {"provider": name, "configured": True, "masked_key": keystore.mask(key)}


@router.delete("/keys/{provider_name}")
def delete_provider_key(provider_name: str) -> dict[str, Any]:
    """Remove key & disable cloud: the key is deleted, routing is left intact —
    the provider simply reports configured=false until a new key arrives."""
    name = _validated_provider(provider_name, allow_local=False)
    keystore.delete_key(name)
    still_configured = bool(providers.resolve_key(name))  # an .env key may remain
    return {"provider": name, "deleted": True, "configured": still_configured}


@router.post("/test/{provider_name}")
def test_provider(provider_name: str) -> dict[str, Any]:
    """Tiny connectivity probe — the only endpoint that may hit the network,
    and it carries no user data."""
    name = _validated_provider(provider_name, allow_local=True)
    eff = _effective()
    started = time.perf_counter()
    try:
        provider = providers.build_provider(name, model=eff["models"].get(name), base_url=eff["base_urls"].get(name))
        reply = provider.generate(
            "You are a connectivity test. Answer exactly as instructed.",
            "Reply with exactly: ok",
            max_tokens=128,
        )
    except (ProviderNotConfigured, ProviderError) as err:
        return {"ok": False, "provider": name, "reason": str(err)}
    return {
        "ok": True,
        "provider": name,
        "model": provider.model,
        "latency_ms": int((time.perf_counter() - started) * 1000),
        "reply": reply.strip()[:80],
    }
