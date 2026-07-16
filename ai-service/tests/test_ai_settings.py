"""AI Settings router + routing model: legacy AI_PROVIDER fallback vs settings
file precedence, per-feature local/cloud/off routing (get_provider_for), BYOK
key endpoints returning masked keys only, the /ai/test connectivity probe, and
the boundary-ledger AuditEvent shape. Keystore and settings paths are isolated
to tmp_path — the real Keychain and data/secrets are never touched."""

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import ai_settings, keystore, providers
from app import fhir_consts as fc


@pytest.fixture(autouse=True)
def _isolated(monkeypatch, tmp_path):
    """Never touch the real macOS Keychain, data/secrets, or the machine's .env keys."""
    monkeypatch.setattr(keystore, "_use_keychain", lambda: False)
    monkeypatch.setattr(keystore, "SECRETS_DIR", tmp_path / "secrets")
    monkeypatch.setattr(ai_settings, "SETTINGS_FILE", tmp_path / "secrets" / "ai-settings.json")
    for field in ("ai_provider", "ai_model", "anthropic_api_key", "openai_api_key", "gemini_api_key"):
        monkeypatch.setattr(ai_settings.settings, field, "")
    monkeypatch.setattr(ai_settings.settings, "openai_base_url", "https://api.openai.com/v1")
    monkeypatch.setattr(ai_settings.settings, "ollama_base_url", "http://localhost:11434/")


@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(ai_settings.router)
    return TestClient(app)


def _provider_entry(body: dict, name: str) -> dict:
    return next(p for p in body["providers"] if p["name"] == name)


# --- GET/PUT /ai/settings -------------------------------------------------------


def test_get_settings_unconfigured(client):
    resp = client.get("/ai/settings")
    assert resp.status_code == 200
    body = resp.json()
    assert [p["name"] for p in body["providers"]] == ["anthropic", "openai", "gemini", "ollama"]
    ollama = _provider_entry(body, "ollama")
    assert ollama["is_local"] is True
    assert ollama["configured"] is True  # local path needs no key
    for name in ("anthropic", "openai", "gemini"):
        entry = _provider_entry(body, name)
        assert entry["configured"] is False
        assert entry["is_local"] is False
        assert "masked_key" not in entry
    assert body["cloud_provider"] is None
    assert body["routing"] == dict.fromkeys(ai_settings.FEATURES, "cloud")


def test_settings_follow_env_when_file_absent(client, monkeypatch):
    monkeypatch.setattr(ai_settings.settings, "ai_provider", "anthropic")
    monkeypatch.setattr(ai_settings.settings, "anthropic_api_key", "sk-ant-env-key-9876")
    body = client.get("/ai/settings").json()
    assert body["cloud_provider"] == "anthropic"
    assert body["routing"] == dict.fromkeys(ai_settings.FEATURES, "cloud")
    entry = _provider_entry(body, "anthropic")
    assert entry["configured"] is True
    assert entry["masked_key"] == keystore.mask("sk-ant-env-key-9876")

    monkeypatch.setattr(ai_settings.settings, "ai_provider", "ollama")
    body = client.get("/ai/settings").json()
    assert body["routing"] == dict.fromkeys(ai_settings.FEATURES, "local")
    assert body["cloud_provider"] is None


def test_put_settings_validates(client):
    assert client.put("/ai/settings", json={"routing": {"bogus-feature": "cloud"}}).status_code == 400
    assert client.put("/ai/settings", json={"routing": {"assistant": "sideways"}}).status_code == 400
    assert client.put("/ai/settings", json={"cloud_provider": "hal9000"}).status_code == 400
    assert client.put("/ai/settings", json={"cloud_provider": "ollama"}).status_code == 400
    assert client.put("/ai/settings", json={"models": {"hal9000": "x"}}).status_code == 400
    assert not ai_settings.SETTINGS_FILE.exists()  # nothing persisted on validation failure


def test_put_settings_persists_and_round_trips(client):
    resp = client.put(
        "/ai/settings",
        json={
            "routing": {"assistant": "off", "health-review": "local"},
            "cloud_provider": "openai",
            "models": {"openai": "gpt-4o-mini", "ollama": "llama3.2-vision"},
        },
    )
    assert resp.status_code == 200
    assert ai_settings.SETTINGS_FILE.exists()
    assert (ai_settings.SETTINGS_FILE.stat().st_mode & 0o777) == 0o600

    body = client.get("/ai/settings").json()
    assert body["cloud_provider"] == "openai"
    assert body["routing"]["assistant"] == "off"
    assert body["routing"]["health-review"] == "local"
    assert body["routing"]["ingest-extraction"] == "cloud"
    assert _provider_entry(body, "openai")["model"] == "gpt-4o-mini"
    assert _provider_entry(body, "ollama")["model"] == "llama3.2-vision"

    # partial update keeps earlier choices
    client.put("/ai/settings", json={"routing": {"nl-import": "off"}})
    body = client.get("/ai/settings").json()
    assert body["routing"]["assistant"] == "off"
    assert body["routing"]["nl-import"] == "off"
    assert body["cloud_provider"] == "openai"


# --- key endpoints ---------------------------------------------------------------


def test_key_endpoints_set_mask_delete(client):
    resp = client.post("/ai/keys/openai", json={"key": "sk-live-abcdef123456"})
    assert resp.status_code == 200
    assert resp.json()["masked_key"] == "sk-…3456"
    assert "abcdef" not in resp.text  # never returned unmasked

    body = client.get("/ai/settings").json()
    entry = _provider_entry(body, "openai")
    assert entry["configured"] is True
    assert entry["masked_key"] == "sk-…3456"
    assert "abcdef" not in client.get("/ai/settings").text

    resp = client.delete("/ai/keys/openai")
    assert resp.status_code == 200
    assert resp.json()["configured"] is False
    assert _provider_entry(client.get("/ai/settings").json(), "openai")["configured"] is False


def test_key_endpoints_reject_unknown_and_local(client):
    assert client.post("/ai/keys/hal9000", json={"key": "x"}).status_code == 400
    assert client.post("/ai/keys/ollama", json={"key": "x"}).status_code == 400
    assert client.post("/ai/keys/openai", json={"key": "   "}).status_code == 400
    assert client.delete("/ai/keys/hal9000").status_code == 400


def test_delete_key_leaves_routing_intact(client):
    client.put("/ai/settings", json={"cloud_provider": "openai", "routing": {"assistant": "cloud"}})
    client.post("/ai/keys/openai", json={"key": "sk-live-abcdef123456"})
    client.delete("/ai/keys/openai")
    body = client.get("/ai/settings").json()
    assert body["cloud_provider"] == "openai"  # routing/choice intact
    assert body["routing"]["assistant"] == "cloud"
    assert _provider_entry(body, "openai")["configured"] is False


# --- get_provider_for -------------------------------------------------------------


def test_get_provider_for_unknown_feature():
    with pytest.raises(ValueError, match="unknown AI feature"):
        ai_settings.get_provider_for("time-travel")


def test_get_provider_for_off(client):
    client.put("/ai/settings", json={"routing": {"assistant": "off"}})
    with pytest.raises(providers.ProviderNotConfigured, match="turned off"):
        ai_settings.get_provider_for("assistant")


def test_get_provider_for_local_returns_ollama(client):
    client.put("/ai/settings", json={"routing": {"health-review": "local"}, "models": {"ollama": "mistral"}})
    provider = ai_settings.get_provider_for("health-review")
    assert provider.name == "ollama"
    assert provider.is_local is True
    assert provider.model == "mistral"


def test_get_provider_for_cloud_without_key_raises(client):
    client.put("/ai/settings", json={"cloud_provider": "gemini"})
    with pytest.raises(providers.ProviderNotConfigured, match="Gemini"):
        ai_settings.get_provider_for("assistant")


def test_get_provider_for_cloud_no_provider_chosen(client):
    client.put("/ai/settings", json={"routing": {"assistant": "cloud"}})
    with pytest.raises(providers.ProviderNotConfigured, match="No AI provider configured"):
        ai_settings.get_provider_for("assistant")


def test_get_provider_for_absent_file_follows_env(monkeypatch):
    with pytest.raises(providers.ProviderNotConfigured):
        ai_settings.get_provider_for("assistant")  # AI_PROVIDER empty → off
    monkeypatch.setattr(ai_settings.settings, "ai_provider", "ollama")
    provider = ai_settings.get_provider_for("assistant")
    assert provider.name == "ollama"
    assert provider.is_local is True


# --- POST /ai/test/{provider} ------------------------------------------------------


def test_test_endpoint_reports_unconfigured_without_network(client):
    resp = client.post("/ai/test/openai")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert "OpenAI" in body["reason"]


def test_test_endpoint_unknown_provider(client):
    assert client.post("/ai/test/hal9000").status_code == 400


def test_test_endpoint_success(client, monkeypatch):
    keystore.set_key("openai", "sk-test")
    original_post = httpx.Client.post

    def fake_post(self, url, *args, **kwargs):
        # TestClient itself may go through httpx.Client.post — only fake OpenAI.
        if "chat/completions" not in str(url):
            return original_post(self, url, *args, **kwargs)
        body = {"choices": [{"finish_reason": "stop", "message": {"content": "ok"}}]}
        return httpx.Response(200, json=body, request=httpx.Request("POST", str(url)))

    monkeypatch.setattr(httpx.Client, "post", fake_post)
    body = client.post("/ai/test/openai").json()
    assert body["ok"] is True
    assert body["model"] == providers.DEFAULT_OPENAI_MODEL
    assert isinstance(body["latency_ms"], int)
    assert body["reply"] == "ok"


# --- boundary ledger ----------------------------------------------------------------


class _FakeMedplum:
    def __init__(self):
        self.created = []

    def create(self, resource):
        self.created.append(resource)
        return {**resource, "id": "audit-1"}


def test_log_boundary_event_writes_audit_event():
    fake = _FakeMedplum()
    result = ai_settings.log_boundary_event(fake, "health-review", "anthropic", "90-day review")
    assert result["id"] == "audit-1"
    event = fake.created[0]
    assert event["resourceType"] == "AuditEvent"
    # Machine-readable ledger coding — HistoryPage filters on exactly this
    # (type = local cloud-egress code, subtype = feature slug).
    assert event["type"]["system"] == fc.CS_AUDIT
    assert event["type"]["code"] == "cloud-egress"
    assert event["subtype"] == [{"system": fc.CS_AUDIT, "code": "health-review"}]
    assert event["outcome"] == "0"
    assert event["agent"][0]["name"] == "healmedaily-ai"
    assert event["agent"][0]["requestor"] is True
    assert event["source"]["observer"]["display"] == "healmedaily-ai"
    entity = event["entity"][0]
    # The human description format is load-bearing: legacy (pre-coding) events
    # are recognized by it, and it still names the provider for the UI.
    assert entity["description"] == "AI request · health-review → anthropic · data left this device"
    assert entity["name"] == "90-day review"
    assert event["recorded"]
