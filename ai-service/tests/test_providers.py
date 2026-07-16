"""Provider adapter layer without any network: request shapes per provider
(OpenAI vision/schema payloads, Gemini schema stripping + key-in-header,
Ollama json format + PDF rejection), the error-mapping table (bad key →
ProviderNotConfigured, 429/5xx/truncation → ProviderError), single retry on
transport errors, key resolution precedence (keystore beats .env) and
mask() never revealing a key. httpx.Client.post is monkeypatched throughout."""

import json

import httpx
import pytest

from app import ai_settings, keystore, providers


@pytest.fixture(autouse=True)
def _isolated(monkeypatch, tmp_path):
    """Never touch the real macOS Keychain, data/secrets, or the machine's .env keys."""
    monkeypatch.setattr(keystore, "_use_keychain", lambda: False)
    monkeypatch.setattr(keystore, "SECRETS_DIR", tmp_path / "secrets")
    monkeypatch.setattr(ai_settings, "SETTINGS_FILE", tmp_path / "secrets" / "ai-settings.json")
    for field in ("ai_provider", "ai_model", "anthropic_api_key", "openai_api_key", "gemini_api_key"):
        monkeypatch.setattr(providers.settings, field, "")
    monkeypatch.setattr(providers.settings, "openai_base_url", "https://api.openai.com/v1")
    monkeypatch.setattr(providers.settings, "ollama_base_url", "http://localhost:11434/")


def _response(status: int, body: dict) -> httpx.Response:
    return httpx.Response(status, json=body, request=httpx.Request("POST", "https://unit.test"))


def _record_posts(monkeypatch, outcomes: list) -> list[dict]:
    """Monkeypatch httpx.Client.post; each outcome is an httpx.Response or an
    exception to raise. Returns the list of captured calls."""
    calls: list[dict] = []
    queue = list(outcomes)

    def fake_post(self, url, headers=None, json=None, **kwargs):
        calls.append({"url": url, "headers": dict(headers or {}), "json": json})
        outcome = queue.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(httpx.Client, "post", fake_post)
    return calls


def _openai_ok(text: str = "hello") -> httpx.Response:
    return _response(200, {"choices": [{"finish_reason": "stop", "message": {"content": text}}]})


# --- legacy get_provider / provider_status ------------------------------------


def test_no_provider_selected():
    with pytest.raises(providers.ProviderNotConfigured):
        providers.get_provider()
    status = providers.provider_status()
    assert status["configured"] is False
    assert "AI" in status["reason"]


def test_anthropic_without_key(monkeypatch):
    monkeypatch.setattr(providers.settings, "ai_provider", "anthropic")
    with pytest.raises(providers.ProviderNotConfigured, match="ANTHROPIC_API_KEY"):
        providers.get_provider()


def test_unknown_provider(monkeypatch):
    monkeypatch.setattr(providers.settings, "ai_provider", "hal9000")
    with pytest.raises(providers.ProviderNotConfigured, match="Unknown"):
        providers.get_provider()


def test_legacy_env_provider_builds_openai(monkeypatch):
    monkeypatch.setattr(providers.settings, "ai_provider", "openai")
    monkeypatch.setattr(providers.settings, "openai_api_key", "sk-env-key")
    provider = providers.get_provider()
    assert provider.name == "openai"
    assert provider.is_local is False
    assert provider.model == providers.DEFAULT_OPENAI_MODEL


def test_legacy_env_model_applies_only_to_selected_provider(monkeypatch):
    monkeypatch.setattr(providers.settings, "ai_provider", "openai")
    monkeypatch.setattr(providers.settings, "ai_model", "gpt-4o-mini")
    monkeypatch.setattr(providers.settings, "openai_api_key", "sk-x")
    assert providers.get_provider().model == "gpt-4o-mini"
    # AI_MODEL must not leak onto a different provider
    assert providers.OllamaProvider().model == providers.DEFAULT_OLLAMA_MODEL


# --- OpenAI --------------------------------------------------------------------


def test_openai_request_shape_vision_and_schema(monkeypatch):
    monkeypatch.setattr(providers.settings, "openai_api_key", "sk-test-1234")
    calls = _record_posts(monkeypatch, [_openai_ok('{"a": 1}')])
    blocks = [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAA="}},
        {"type": "text", "text": "Extract"},
    ]
    schema = {"type": "object", "properties": {"a": {"type": "number"}}}
    out = providers.OpenAIProvider().generate_json("sys", blocks, schema)
    assert out == {"a": 1}

    call = calls[0]
    assert call["url"] == "https://api.openai.com/v1/chat/completions"
    assert call["headers"]["Authorization"] == "Bearer sk-test-1234"
    sent = call["json"]
    assert sent["model"] == providers.DEFAULT_OPENAI_MODEL
    assert sent["response_format"]["type"] == "json_schema"
    assert sent["response_format"]["json_schema"]["schema"] == schema
    assert sent["messages"][0] == {"role": "system", "content": "sys"}
    user_parts = sent["messages"][1]["content"]
    assert user_parts[0] == {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA="}}
    assert user_parts[1] == {"type": "text", "text": "Extract"}


def test_openai_custom_base_url(monkeypatch):
    monkeypatch.setattr(providers.settings, "openai_api_key", "sk-x")
    monkeypatch.setattr(providers.settings, "openai_base_url", "http://localhost:9999/v1/")
    calls = _record_posts(monkeypatch, [_openai_ok()])
    providers.OpenAIProvider().generate("s", "hello")
    assert calls[0]["url"] == "http://localhost:9999/v1/chat/completions"


def test_openai_bad_key_maps_to_not_configured(monkeypatch):
    monkeypatch.setattr(providers.settings, "openai_api_key", "sk-bad")
    _record_posts(monkeypatch, [_response(401, {"error": {"message": "bad key"}})])
    with pytest.raises(providers.ProviderNotConfigured, match="rejected the API key"):
        providers.OpenAIProvider().generate("s", "u")


def test_openai_rate_limit_and_server_error_map_to_provider_error(monkeypatch):
    monkeypatch.setattr(providers.settings, "openai_api_key", "sk-x")
    _record_posts(monkeypatch, [_response(429, {}), _response(503, {})])
    provider = providers.OpenAIProvider()
    with pytest.raises(providers.ProviderError, match="rate limit"):
        provider.generate("s", "u")
    with pytest.raises(providers.ProviderError, match="server error"):
        provider.generate("s", "u")


def test_openai_truncation_is_an_error(monkeypatch):
    monkeypatch.setattr(providers.settings, "openai_api_key", "sk-x")
    body = {"choices": [{"finish_reason": "length", "message": {"content": "partial"}}]}
    _record_posts(monkeypatch, [_response(200, body)])
    with pytest.raises(providers.ProviderError, match="truncated"):
        providers.OpenAIProvider().generate("s", "u")


def test_transient_network_error_retried_once(monkeypatch):
    monkeypatch.setattr(providers.settings, "openai_api_key", "sk-x")
    calls = _record_posts(monkeypatch, [httpx.ReadError("blip"), _openai_ok("recovered")])
    assert providers.OpenAIProvider().generate("s", "u") == "recovered"
    assert len(calls) == 2


# --- Gemini --------------------------------------------------------------------


def test_gemini_request_shape_and_schema_stripping(monkeypatch):
    monkeypatch.setattr(providers.settings, "gemini_api_key", "g-key")
    body = {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": '{"b": 2}'}]}}]}
    calls = _record_posts(monkeypatch, [_response(200, body)])
    schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {"b": {"type": "number", "additionalProperties": False}},
        "required": ["b"],
    }
    blocks = [
        {"type": "text", "text": "hi"},
        {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "QQ=="}},
    ]
    out = providers.GeminiProvider().generate_json("sys", blocks, schema)
    assert out == {"b": 2}

    call = calls[0]
    assert f"models/{providers.DEFAULT_GEMINI_MODEL}:generateContent" in call["url"]
    assert "key=" not in call["url"]  # the key travels in a header, never the URL
    assert call["headers"]["x-goog-api-key"] == "g-key"
    sent = call["json"]
    assert sent["systemInstruction"]["parts"] == [{"text": "sys"}]
    cfg = sent["generationConfig"]
    assert cfg["responseMimeType"] == "application/json"
    assert "additionalProperties" not in json.dumps(cfg["responseSchema"])
    assert cfg["responseSchema"]["type"] == "OBJECT"
    assert cfg["responseSchema"]["properties"]["b"]["type"] == "NUMBER"
    parts = sent["contents"][0]["parts"]
    assert parts[1] == {"inline_data": {"mime_type": "application/pdf", "data": "QQ=="}}


def test_gemini_invalid_key_maps_to_not_configured(monkeypatch):
    monkeypatch.setattr(providers.settings, "gemini_api_key", "g-bad")
    body = {"error": {"code": 400, "message": "API key not valid.", "status": "INVALID_ARGUMENT"}}
    _record_posts(monkeypatch, [_response(400, body)])
    with pytest.raises(providers.ProviderNotConfigured, match="rejected the API key"):
        providers.GeminiProvider().generate("s", "u")


# --- Ollama --------------------------------------------------------------------


def test_ollama_request_shape_and_json_format(monkeypatch):
    body = {"message": {"role": "assistant", "content": '{"c": 3}'}, "done_reason": "stop"}
    calls = _record_posts(monkeypatch, [_response(200, body)])
    provider = providers.OllamaProvider()
    assert provider.is_local is True
    out = provider.generate_json("sys", "text in", {"type": "object"})
    assert out == {"c": 3}

    call = calls[0]
    assert call["url"] == "http://localhost:11434/api/chat"
    sent = call["json"]
    assert sent["format"] == "json"
    assert sent["stream"] is False
    assert sent["model"] == providers.DEFAULT_OLLAMA_MODEL
    assert sent["messages"][0] == {"role": "system", "content": "sys"}
    assert "text in" in sent["messages"][1]["content"]


def test_ollama_connection_refused_maps_to_not_configured(monkeypatch):
    # raised twice: the transient-error retry fires first, then the mapping
    _record_posts(monkeypatch, [httpx.ConnectError("refused"), httpx.ConnectError("refused")])
    with pytest.raises(providers.ProviderNotConfigured, match="Ollama not running at"):
        providers.OllamaProvider().generate("s", "u")


def test_ollama_rejects_pdf_document_blocks(monkeypatch):
    blocks = [{"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "QQ=="}}]
    with pytest.raises(providers.ProviderError, match="PDF"):
        providers.OllamaProvider().generate("s", blocks)


# --- KeyStore ------------------------------------------------------------------


def test_keystore_file_backend_roundtrip():
    assert keystore.get_key("openai") is None
    keystore.set_key("openai", "sk-abc123456789")
    path = keystore.SECRETS_DIR / "ai-keys.json"
    assert path.exists()
    assert (path.stat().st_mode & 0o777) == 0o600
    assert keystore.get_key("openai") == "sk-abc123456789"
    keystore.delete_key("openai")
    assert keystore.get_key("openai") is None
    keystore.delete_key("openai")  # idempotent


def test_keystore_key_beats_env(monkeypatch):
    monkeypatch.setattr(providers.settings, "openai_api_key", "sk-env")
    keystore.set_key("openai", "sk-store")
    calls = _record_posts(monkeypatch, [_openai_ok()])
    providers.OpenAIProvider().generate("s", "u")
    assert calls[0]["headers"]["Authorization"] == "Bearer sk-store"


def test_mask_never_reveals_key():
    masked = keystore.mask("sk-ant-api03-verylongsecretwxyz")
    assert masked == "sk-…wxyz"
    assert "verylongsecret" not in masked
    assert keystore.mask("short").startswith("…")
    assert keystore.mask("") == ""
