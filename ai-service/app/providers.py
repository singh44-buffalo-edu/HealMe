"""Pluggable AI provider layer (Phase 7: all four adapters live).

Anthropic uses its existing SDK; OpenAI, Gemini and Ollama speak plain httpx —
no extra dependencies. Every provider exposes the same interface used by
health_review.py, ingest.py, assistant.py:

    provider.generate(system, user_content, max_tokens=..., output_schema=...)
    provider.generate_json(system, user_content, schema, max_tokens=...)
    provider.name / provider.model / provider.is_local

Adapter contract:
- `user_content` is a string or a list of Anthropic-style content blocks
  (text / image / document with base64 source) — each adapter translates to
  its wire shape, and raises ProviderError for blocks it cannot carry
  (e.g. PDFs to Ollama). This lets scanned documents flow to vision models
  without callers knowing which provider is active.
- `output_schema` requests structured output; adapters use the strongest
  native mechanism available (see per-provider sections) and generate_json
  parses the result. Constructors raise ProviderNotConfigured when no key is
  resolvable, BEFORE any network I/O.
- `is_local` marks the privacy-preserving path (Ollama). ai_settings uses it
  to decide whether a cloud-boundary AuditEvent must be written.

Error mapping — every adapter normalizes failures onto two exceptions, which
main._wrap / assistant._wrap turn into HTTP statuses:

    ProviderNotConfigured (→ 503, "configure a provider" UI state):
      no provider selected · unknown name · missing key · key rejected
      (HTTP 401/403, Anthropic AuthenticationError, Gemini 400 "api key",
      Ollama connection refused = not running)
    ProviderError (→ 502, transient/upstream):
      rate limit (429) · provider 5xx · network/transport failure ·
      truncated output (stop max_tokens / length / MAX_TOKENS) ·
      safety refusal (refusal stop / content_filter / SAFETY...) ·
      empty or unparseable response · unsupported content block

Truncation is a hard error on purpose: a silently cut-off summary must never
be stored as an official record.

Guardrails: never send data to an unconfigured provider (ProviderNotConfigured
before any network call); the app must run fully with AI disabled. Keys resolve
KeyStore-first, then env (.env), and are never logged.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from . import keystore
from .config import settings

# Defaults chosen conservatively — adjust per-provider in AI Settings (models map).
DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8"
DEFAULT_OPENAI_MODEL = "gpt-4o"
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
DEFAULT_OLLAMA_MODEL = "llama3.2"

DEFAULT_MODELS = {
    "anthropic": DEFAULT_ANTHROPIC_MODEL,
    "openai": DEFAULT_OPENAI_MODEL,
    "gemini": DEFAULT_GEMINI_MODEL,
    "ollama": DEFAULT_OLLAMA_MODEL,
}

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

# Generous ceiling: a 90-day Health Review over a scanned PDF can legitimately
# take a minute or two on slower models.
REQUEST_TIMEOUT_SECONDS = 120.0

# Shared user-facing messages so all four adapters fail identically.
_TRUNCATED_MSG = "Model output was truncated (max tokens) — try a smaller window"
_DECLINED_MSG = "The model declined this request (safety refusal)"


class ProviderNotConfigured(RuntimeError):
    """AI feature requested but no usable provider is configured."""


class ProviderError(RuntimeError):
    """Provider is configured but the request failed (bad key, rate limit...)."""


def env_key(name: str) -> str:
    """The .env fallback key for a provider ("" when unset or unknown name)."""
    return {
        "anthropic": settings.anthropic_api_key,
        "openai": settings.openai_api_key,
        "gemini": settings.gemini_api_key,
    }.get(name, "")


def resolve_key(name: str) -> str | None:
    """KeyStore (Keychain / secrets file) wins over the .env variable."""
    return keystore.get_key(name) or env_key(name).strip() or None


def resolve_model(name: str, explicit: str | None = None) -> str:
    """explicit (AI Settings models map) > AI_MODEL env (legacy, only when
    AI_PROVIDER names the same provider) > per-provider default."""
    if explicit:
        return explicit
    if settings.ai_model and settings.ai_provider.strip().lower() == name:
        return settings.ai_model
    return DEFAULT_MODELS[name]


def _post_json(url: str, headers: dict[str, str] | None, payload: dict[str, Any]) -> httpx.Response:
    """POST with a 120s timeout and one retry on transient transport errors."""
    for attempt in (1, 2):
        try:
            with httpx.Client(timeout=REQUEST_TIMEOUT_SECONDS) as client:
                return client.post(url, headers=headers or {}, json=payload)
        except httpx.TransportError:
            if attempt == 2:
                raise
    raise AssertionError("unreachable")


def _check_response(resp: httpx.Response, label: str) -> dict[str, Any]:
    """Common HTTP status → error mapping. Bodies may appear in errors; keys never do."""
    if resp.status_code in (401, 403):
        raise ProviderNotConfigured(f"{label} rejected the API key (HTTP {resp.status_code})")
    if resp.status_code == 429:
        raise ProviderError(f"{label} rate limit hit — try again shortly")
    if resp.status_code >= 500:
        raise ProviderError(f"{label} server error (HTTP {resp.status_code}) — try again shortly")
    if resp.status_code >= 400:
        raise ProviderError(f"{label} API error {resp.status_code}: {resp.text[:300]}")
    try:
        data = resp.json()
    except (json.JSONDecodeError, ValueError) as err:
        raise ProviderError(f"{label} returned a non-JSON response") from err
    if not isinstance(data, dict):
        raise ProviderError(f"{label} returned an unexpected response shape")
    return data


class _BaseProvider:
    """Adapter base: subclasses set name/is_local, resolve their key in
    __init__ (raising ProviderNotConfigured when absent) and implement
    generate(). Callers depend only on this interface."""

    name = ""
    is_local = False
    model = ""

    def generate(
        self,
        system: str,
        user_content: str | list[dict[str, Any]],
        max_tokens: int = 16000,
        output_schema: dict[str, Any] | None = None,
    ) -> str:
        """One system+user completion → text. `output_schema` constrains the
        reply to a JSON schema where the provider supports it. Raises
        ProviderError / ProviderNotConfigured per the module error table."""
        raise NotImplementedError

    def generate_json(
        self,
        system: str,
        user_content: str | list[dict[str, Any]],
        schema: dict[str, Any],
        max_tokens: int = 16000,
    ) -> Any:
        """generate() + json.loads. A malformed-JSON reply surfaces as
        json.JSONDecodeError → ValueError → HTTP 400 via the _wrap helpers."""
        return json.loads(self.generate(system, user_content, max_tokens, output_schema=schema))


# --- Anthropic (SDK) ----------------------------------------------------------
# API shape: official `anthropic` SDK, Messages API. Content blocks pass
# through natively (they ARE Anthropic-shaped); structured output via
# output_config json_schema; refusal/truncation read from stop_reason.


class AnthropicProvider(_BaseProvider):
    """Cloud adapter over the Anthropic SDK — the owner's primary provider
    (CLAUDE.md §8). SDK exception classes map onto the module error table."""

    name = "anthropic"
    is_local = False

    def __init__(self, model: str | None = None) -> None:
        key = resolve_key("anthropic")
        if not key:
            raise ProviderNotConfigured("No Anthropic key — add one in AI Settings or set ANTHROPIC_API_KEY in .env")
        import anthropic

        self._anthropic = anthropic
        self._client = anthropic.Anthropic(api_key=key)
        self.model = resolve_model("anthropic", model)

    def generate(
        self,
        system: str,
        user_content: str | list[dict[str, Any]],
        max_tokens: int = 16000,
        output_schema: dict[str, Any] | None = None,
    ) -> str:
        """Run one generation. `user_content` is a string or a list of content
        blocks (text/document/image) so scanned PDFs can go straight to a
        vision-capable model. With `output_schema`, the response is constrained
        to that JSON schema (structured outputs)."""
        kwargs: dict[str, Any] = {}
        if output_schema is not None:
            kwargs["output_config"] = {"format": {"type": "json_schema", "schema": output_schema}}
        try:
            response = self._client.messages.create(
                model=self.model,
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": user_content}],
                **kwargs,
            )
        except self._anthropic.AuthenticationError as err:
            raise ProviderNotConfigured(f"Anthropic rejected the API key: {err.message}") from err
        except self._anthropic.RateLimitError as err:
            raise ProviderError("Anthropic rate limit hit — try again shortly") from err
        except self._anthropic.APIStatusError as err:
            raise ProviderError(f"Anthropic API error {err.status_code}: {err.message}") from err
        except self._anthropic.APIConnectionError as err:
            raise ProviderError("Could not reach the Anthropic API (network)") from err

        if response.stop_reason == "refusal":
            raise ProviderError(_DECLINED_MSG)
        if response.stop_reason == "max_tokens":
            # Never store a silently truncated summary as an official record.
            raise ProviderError(_TRUNCATED_MSG)
        text = "\n".join(block.text for block in response.content if block.type == "text")
        if not text.strip():
            raise ProviderError(f"Empty model response (stop_reason={response.stop_reason})")
        return text


# --- OpenAI (httpx) -----------------------------------------------------------
# API shape: POST {base}/chat/completions with system+user messages. Content
# blocks translate to image_url / file parts carrying data: URLs; structured
# output via response_format json_schema; refusal/truncation read from
# finish_reason and message.refusal.


def _openai_content(user_content: str | list[dict[str, Any]]) -> str | list[dict[str, Any]]:
    """Anthropic-style blocks → OpenAI chat content parts (images and PDFs
    become data: URLs). Raises ProviderError on block types OpenAI lacks."""
    if isinstance(user_content, str):
        return user_content
    parts: list[dict[str, Any]] = []
    for block in user_content:
        btype = block.get("type")
        if btype == "text":
            parts.append({"type": "text", "text": block["text"]})
        elif btype in ("image", "document"):
            source = block.get("source", {})
            data_url = f"data:{source.get('media_type', 'application/octet-stream')};base64,{source.get('data', '')}"
            if btype == "image":
                parts.append({"type": "image_url", "image_url": {"url": data_url}})
            else:
                parts.append({"type": "file", "file": {"filename": "document.pdf", "file_data": data_url}})
        else:
            raise ProviderError(f"unsupported content block type '{btype}' for OpenAI")
    return parts


class OpenAIProvider(_BaseProvider):
    """Cloud adapter speaking the Chat Completions REST API via httpx (no SDK
    dependency). OPENAI_BASE_URL supports proxies/Azure-style gateways."""

    name = "openai"
    is_local = False

    def __init__(self, model: str | None = None) -> None:
        key = resolve_key("openai")
        if not key:
            raise ProviderNotConfigured("No OpenAI key — add one in AI Settings or set OPENAI_API_KEY in .env")
        self._api_key = key
        # OPENAI_BASE_URL supports the "custom endpoint" option (proxies, Azure-style gateways).
        self.base_url = (settings.openai_base_url or "https://api.openai.com/v1").rstrip("/")
        self.model = resolve_model("openai", model)

    def generate(
        self,
        system: str,
        user_content: str | list[dict[str, Any]],
        max_tokens: int = 16000,
        output_schema: dict[str, Any] | None = None,
    ) -> str:
        payload: dict[str, Any] = {
            "model": self.model,
            "max_completion_tokens": max_tokens,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": _openai_content(user_content)},
            ],
        }
        if output_schema is not None:
            payload["response_format"] = {
                "type": "json_schema",
                # strict mode would require every property in `required`; our
                # schemas use optional fields, so validate loosely instead.
                "json_schema": {"name": "structured_output", "schema": output_schema, "strict": False},
            }
        try:
            resp = _post_json(
                f"{self.base_url}/chat/completions",
                {"Authorization": f"Bearer {self._api_key}"},
                payload,
            )
        except httpx.TransportError as err:
            raise ProviderError("Could not reach the OpenAI API (network)") from err
        data = _check_response(resp, "OpenAI")

        choices = data.get("choices") or []
        if not choices:
            raise ProviderError("OpenAI returned no choices")
        choice = choices[0]
        finish = choice.get("finish_reason")
        if finish == "length":
            raise ProviderError(_TRUNCATED_MSG)
        if finish == "content_filter" or (choice.get("message") or {}).get("refusal"):
            raise ProviderError(_DECLINED_MSG)
        text = (choice.get("message") or {}).get("content") or ""
        if not text.strip():
            raise ProviderError(f"Empty model response (finish_reason={finish})")
        return text


# --- Gemini (httpx) -----------------------------------------------------------
# API shape: POST {base}/models/{model}:generateContent with
# systemInstruction / contents / generationConfig. Content blocks translate to
# inline_data parts; structured output via responseMimeType+responseSchema;
# refusal read from promptFeedback.blockReason and candidate finishReason.

# Gemini's responseSchema is an OpenAPI subset — strip JSON-schema keywords it
# rejects (additionalProperties, $schema, ...) and uppercase type names.
_GEMINI_SCHEMA_KEYS = {"type", "format", "description", "enum", "items", "properties", "required", "nullable"}


def _gemini_schema(schema: Any) -> Any:
    """Recursively project a JSON schema onto the keyword subset Gemini's
    responseSchema accepts (see _GEMINI_SCHEMA_KEYS above)."""
    if isinstance(schema, list):
        return [_gemini_schema(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    out: dict[str, Any] = {}
    for key, value in schema.items():
        if key not in _GEMINI_SCHEMA_KEYS:
            continue
        if key == "properties" and isinstance(value, dict):
            out[key] = {name: _gemini_schema(sub) for name, sub in value.items()}
        elif key == "items":
            out[key] = _gemini_schema(value)
        elif key == "type" and isinstance(value, str):
            out[key] = value.upper()
        else:
            out[key] = value
    return out


def _gemini_parts(user_content: str | list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Anthropic-style blocks → Gemini `parts` (images/PDFs both ride as
    inline_data with their mime type)."""
    if isinstance(user_content, str):
        return [{"text": user_content}]
    parts: list[dict[str, Any]] = []
    for block in user_content:
        btype = block.get("type")
        if btype == "text":
            parts.append({"text": block["text"]})
        elif btype in ("image", "document"):
            source = block.get("source", {})
            parts.append(
                {
                    "inline_data": {
                        "mime_type": source.get("media_type", "application/octet-stream"),
                        "data": source.get("data", ""),
                    }
                }
            )
        else:
            raise ProviderError(f"unsupported content block type '{btype}' for Gemini")
    return parts


class GeminiProvider(_BaseProvider):
    """Cloud adapter speaking the generateContent REST API via httpx."""

    name = "gemini"
    is_local = False

    def __init__(self, model: str | None = None) -> None:
        key = resolve_key("gemini")
        if not key:
            raise ProviderNotConfigured("No Gemini key — add one in AI Settings or set GEMINI_API_KEY in .env")
        self._api_key = key
        self.model = resolve_model("gemini", model)

    def generate(
        self,
        system: str,
        user_content: str | list[dict[str, Any]],
        max_tokens: int = 16000,
        output_schema: dict[str, Any] | None = None,
    ) -> str:
        generation_config: dict[str, Any] = {"maxOutputTokens": max_tokens}
        if output_schema is not None:
            generation_config["responseMimeType"] = "application/json"
            generation_config["responseSchema"] = _gemini_schema(output_schema)
        payload = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": _gemini_parts(user_content)}],
            "generationConfig": generation_config,
        }
        try:
            # Key travels in a header, never in the URL (URLs end up in logs).
            resp = _post_json(
                f"{GEMINI_BASE_URL}/models/{self.model}:generateContent",
                {"x-goog-api-key": self._api_key},
                payload,
            )
        except httpx.TransportError as err:
            raise ProviderError("Could not reach the Gemini API (network)") from err
        if resp.status_code == 400 and "api key" in resp.text.lower():
            raise ProviderNotConfigured("Gemini rejected the API key")
        data = _check_response(resp, "Gemini")

        block_reason = (data.get("promptFeedback") or {}).get("blockReason")
        if block_reason:
            raise ProviderError(f"The model declined this request ({block_reason})")
        candidates = data.get("candidates") or []
        if not candidates:
            raise ProviderError("Gemini returned no candidates")
        candidate = candidates[0]
        finish = candidate.get("finishReason")
        if finish == "MAX_TOKENS":
            raise ProviderError(_TRUNCATED_MSG)
        if finish in ("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "RECITATION"):
            raise ProviderError(f"The model declined this request ({finish})")
        parts = (candidate.get("content") or {}).get("parts") or []
        text = "\n".join(part["text"] for part in parts if isinstance(part.get("text"), str))
        if not text.strip():
            raise ProviderError(f"Empty model response (finishReason={finish})")
        return text


# --- Ollama (httpx, local) ----------------------------------------------------
# API shape: POST {base}/api/chat with stream:false. Images ride as a base64
# list on the user message; PDFs are rejected (no document support) — local
# text extraction must succeed first. Structured output: format:"json"
# guarantees syntax only, so the schema itself is appended to the prompt.
# Truncation read from done_reason.


def _ollama_content(user_content: str | list[dict[str, Any]]) -> tuple[str, list[str]]:
    """Anthropic-style blocks → (joined text, base64 image list) for Ollama.
    Document blocks raise ProviderError with routing advice."""
    if isinstance(user_content, str):
        return user_content, []
    texts: list[str] = []
    images: list[str] = []
    for block in user_content:
        btype = block.get("type")
        if btype == "text":
            texts.append(block["text"])
        elif btype == "image":
            images.append(block.get("source", {}).get("data", ""))
        elif btype == "document":
            raise ProviderError(
                "Ollama cannot read PDF documents directly — local text extraction (tesseract/poppler) "
                "must succeed first, or route this feature to a cloud provider"
            )
        else:
            raise ProviderError(f"unsupported content block type '{btype}' for Ollama")
    return "\n\n".join(texts), images


class OllamaProvider(_BaseProvider):
    """Local adapter (no API key). ai_settings routes features here for the
    "local" privacy path; is_local=True means no boundary AuditEvent is due."""

    name = "ollama"
    is_local = True  # the privacy-preserving path: data never leaves this machine

    def __init__(self, model: str | None = None) -> None:
        # No key needed — reachability is checked at request time.
        self.base_url = (settings.ollama_base_url or "http://localhost:11434").rstrip("/")
        self.model = resolve_model("ollama", model)

    def generate(
        self,
        system: str,
        user_content: str | list[dict[str, Any]],
        max_tokens: int = 16000,
        output_schema: dict[str, Any] | None = None,
    ) -> str:
        text, images = _ollama_content(user_content)
        if output_schema is not None:
            # format:"json" guarantees syntax; the schema rides in the prompt.
            text += "\n\nRespond with a single JSON object matching this JSON schema:\n" + json.dumps(output_schema)
        message: dict[str, Any] = {"role": "user", "content": text}
        if images:
            message["images"] = images
        payload: dict[str, Any] = {
            "model": self.model,
            "stream": False,
            "messages": [{"role": "system", "content": system}, message],
            "options": {"num_predict": max_tokens},
        }
        if output_schema is not None:
            payload["format"] = "json"
        try:
            resp = _post_json(f"{self.base_url}/api/chat", None, payload)
        except httpx.ConnectError as err:
            raise ProviderNotConfigured(
                f"Ollama not running at {self.base_url} — start it with `ollama serve` (local AI path)"
            ) from err
        except httpx.TransportError as err:
            raise ProviderError(f"Could not reach Ollama at {self.base_url} (network)") from err
        if resp.status_code == 404:
            raise ProviderError(f"Ollama error: {resp.text[:200]} — is the model pulled? (`ollama pull {self.model}`)")
        data = _check_response(resp, "Ollama")

        if data.get("done_reason") == "length":
            raise ProviderError(_TRUNCATED_MSG)
        text_out = (data.get("message") or {}).get("content") or ""
        if not text_out.strip():
            raise ProviderError("Empty model response from Ollama")
        return text_out


# --- Factory / status ---------------------------------------------------------

# Registry keyed by the canonical provider names used across AI Settings,
# routing files and .env — extend here when adding an adapter.
PROVIDER_CLASSES: dict[str, type[_BaseProvider]] = {
    "anthropic": AnthropicProvider,
    "openai": OpenAIProvider,
    "gemini": GeminiProvider,
    "ollama": OllamaProvider,
}


def build_provider(name: str, model: str | None = None) -> _BaseProvider:
    """Instantiate a provider by name or raise ProviderNotConfigured."""
    name = (name or "").strip().lower()
    if not name:
        raise ProviderNotConfigured(
            "No AI provider selected — configure one in AI Settings or set AI_PROVIDER in .env (AI features are optional)"
        )
    cls = PROVIDER_CLASSES.get(name)
    if cls is None:
        raise ProviderNotConfigured(f"Unknown AI provider '{name}' (anthropic | openai | gemini | ollama)")
    return cls(model=model)


def get_provider() -> _BaseProvider:
    """Legacy feature-less entry point (health_review, ingest): the cloud /
    AI_PROVIDER default. Feature-aware callers use ai_settings.get_provider_for."""
    from .ai_settings import default_provider_spec  # lazy — avoids import cycle

    name, model = default_provider_spec()
    return build_provider(name, model=model)


def provider_status() -> dict[str, Any]:
    """Non-throwing status for the UI's 'configure a provider' state."""
    try:
        provider = get_provider()
        return {
            "provider": provider.name,
            "model": provider.model,
            "configured": True,
            "is_local": provider.is_local,
            "reason": None,
        }
    except ProviderNotConfigured as err:
        return {
            "provider": settings.ai_provider or None,
            "model": settings.ai_model or None,
            "configured": False,
            "is_local": False,
            "reason": str(err),
        }
