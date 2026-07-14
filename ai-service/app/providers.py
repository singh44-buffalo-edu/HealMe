"""Pluggable AI provider layer.

MVP wires the Anthropic adapter only (the owner's only key). OpenAI, Gemini
and Ollama adapters arrive in Phase 7; selecting them today reports "not
configured". Guardrail: never send data to an unconfigured provider — the
app must run fully with AI disabled.
"""

from __future__ import annotations

import json
from typing import Any

from .config import settings

DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8"


class ProviderNotConfigured(RuntimeError):
    """AI feature requested but no usable provider is configured."""


class ProviderError(RuntimeError):
    """Provider is configured but the request failed (bad key, rate limit...)."""


class AnthropicProvider:
    name = "anthropic"

    def __init__(self) -> None:
        if not settings.anthropic_api_key:
            raise ProviderNotConfigured("ANTHROPIC_API_KEY is not set in .env")
        import anthropic

        self._anthropic = anthropic
        self._client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        self.model = settings.ai_model or DEFAULT_ANTHROPIC_MODEL

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
            raise ProviderError("The model declined this request (safety refusal)")
        text = "\n".join(block.text for block in response.content if block.type == "text")
        if not text.strip():
            raise ProviderError(f"Empty model response (stop_reason={response.stop_reason})")
        return text

    def generate_json(
        self,
        system: str,
        user_content: str | list[dict[str, Any]],
        schema: dict[str, Any],
        max_tokens: int = 16000,
    ) -> Any:
        return json.loads(self.generate(system, user_content, max_tokens, output_schema=schema))


_STUB_REASONS = {
    "openai": "OpenAI adapter arrives in Phase 7",
    "gemini": "Gemini adapter arrives in Phase 7",
    "ollama": "Ollama adapter arrives in Phase 7",
}


def get_provider() -> AnthropicProvider:
    """Return the configured provider or raise ProviderNotConfigured."""
    name = settings.ai_provider.strip().lower()
    if not name:
        raise ProviderNotConfigured("No AI provider selected — set AI_PROVIDER in .env (AI features are optional)")
    if name == "anthropic":
        return AnthropicProvider()
    if name in _STUB_REASONS:
        raise ProviderNotConfigured(f"AI_PROVIDER={name}: {_STUB_REASONS[name]}")
    raise ProviderNotConfigured(f"Unknown AI_PROVIDER '{name}' (anthropic | openai | gemini | ollama)")


def provider_status() -> dict[str, Any]:
    """Non-throwing status for the UI's 'configure a provider' state."""
    try:
        provider = get_provider()
        return {"provider": provider.name, "model": provider.model, "configured": True, "reason": None}
    except ProviderNotConfigured as err:
        return {
            "provider": settings.ai_provider or None,
            "model": settings.ai_model or None,
            "configured": False,
            "reason": str(err),
        }
