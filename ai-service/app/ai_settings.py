"""Per-feature AI routing, BYOK key endpoints and the privacy-boundary ledger.

Each AI feature routes to "local" (Ollama — data never leaves this machine),
"cloud" (the single globally-chosen cloud provider) or "off". Routing, the
cloud provider choice and per-provider model overrides persist in
{repo}/data/secrets/ai-settings.json (0o600, gitignored). While that file is
absent, everything follows the legacy AI_PROVIDER env var — backward compat.

Other modules import get_provider_for(feature). Cloud calls are identifiable
via provider.is_local / provider.name, and every request whose data leaves the
device gets an AuditEvent via log_boundary_event.

API keys are never logged and never returned unmasked by any endpoint.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import keystore, providers
from .config import REPO_ROOT, settings
from .providers import ProviderError, ProviderNotConfigured, _BaseProvider

FEATURES = ("health-review", "ingest-extraction", "assistant", "nl-import")
ROUTES = ("local", "cloud", "off")
CLOUD_PROVIDERS = ("anthropic", "openai", "gemini")
ALL_PROVIDERS = CLOUD_PROVIDERS + ("ollama",)

SETTINGS_FILE = REPO_ROOT / "data" / "secrets" / "ai-settings.json"


# --- Persistence --------------------------------------------------------------


def _load() -> dict[str, Any] | None:
    if not SETTINGS_FILE.exists():
        return None
    try:
        data = json.loads(SETTINGS_FILE.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _save(data: dict[str, Any]) -> None:
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
    absent file falls back to the legacy AI_PROVIDER env semantics."""
    data = _load()
    if data is not None:
        stored_routing = data.get("routing") or {}
        routing = {feature: stored_routing.get(feature, "cloud") for feature in FEATURES}
        cloud = data.get("cloud_provider") or settings.ai_provider.strip().lower() or None
        if cloud not in CLOUD_PROVIDERS:
            cloud = None
        models = {k: v for k, v in (data.get("models") or {}).items() if k in ALL_PROVIDERS and v}
        return {"routing": routing, "cloud_provider": cloud, "models": models, "from_file": True}
    env_name = settings.ai_provider.strip().lower()
    if env_name == "ollama":
        return {"routing": dict.fromkeys(FEATURES, "local"), "cloud_provider": None, "models": {}, "from_file": False}
    return {
        "routing": dict.fromkeys(FEATURES, "cloud"),
        "cloud_provider": env_name or None,
        "models": {},
        "from_file": False,
    }


def default_provider_spec() -> tuple[str, str | None]:
    """(name, model) for feature-less legacy callers (providers.get_provider)."""
    eff = _effective()
    if eff["from_file"]:
        name = eff["cloud_provider"] or ""
        return name, eff["models"].get(name)
    return settings.ai_provider.strip().lower(), None


def get_provider_for(feature: str) -> _BaseProvider:
    """The feature-aware entry point other modules import. Returns a Provider
    instance or raises ProviderNotConfigured (routed off / nothing configured)."""
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
    return providers.build_provider(name, model=eff["models"].get(name))


# --- Privacy-boundary ledger ---------------------------------------------------


def log_boundary_event(medplum: Any, feature: str, provider_name: str, description: str) -> dict[str, Any]:
    """One AuditEvent per AI request whose data leaves this device — the
    cloud-boundary ledger. Call sites invoke this for cloud providers only."""
    event = {
        "resourceType": "AuditEvent",
        "type": {
            "system": "http://terminology.hl7.org/CodeSystem/audit-event-type",
            "code": "rest",
            "display": "RESTful Operation",
        },
        "action": "E",
        "recorded": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "outcome": "0",
        "agent": [{"name": "healmedaily-ai", "requestor": True}],
        "source": {"observer": {"display": "healmedaily-ai"}},
        "entity": [
            {
                "name": str(description)[:200],
                "description": f"AI request · {feature} → {provider_name} · data left this device",
            }
        ],
    }
    return medplum.create(event)


# --- Router --------------------------------------------------------------------

router = APIRouter(prefix="/ai", tags=["ai"])


class SettingsUpdate(BaseModel):
    routing: dict[str, str] | None = None
    cloud_provider: str | None = None
    models: dict[str, str] | None = None


class KeyBody(BaseModel):
    key: str


def _validated_provider(name: str, allow_local: bool) -> str:
    name = name.strip().lower()
    if name == "ollama" and not allow_local:
        raise HTTPException(status_code=400, detail="ollama is the local provider — it needs no API key")
    if name not in ALL_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"unknown provider '{name}' — one of {', '.join(ALL_PROVIDERS)}")
    return name


def _settings_payload() -> dict[str, Any]:
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
        provider_list.append(entry)
    return {"providers": provider_list, "routing": eff["routing"], "cloud_provider": eff["cloud_provider"]}


@router.get("/settings")
def get_settings() -> dict[str, Any]:
    return _settings_payload()


@router.put("/settings")
def update_settings(body: SettingsUpdate) -> dict[str, Any]:
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

    _save({"routing": routing, "cloud_provider": cloud, "models": models})
    return _settings_payload()


@router.post("/keys/{provider_name}")
def set_provider_key(provider_name: str, body: KeyBody) -> dict[str, Any]:
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
        provider = providers.build_provider(name, model=eff["models"].get(name))
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
