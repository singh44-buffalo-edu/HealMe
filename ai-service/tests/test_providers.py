import pytest

from app import providers


def test_no_provider_selected(monkeypatch):
    monkeypatch.setattr(providers.settings, "ai_provider", "")
    with pytest.raises(providers.ProviderNotConfigured):
        providers.get_provider()
    status = providers.provider_status()
    assert status["configured"] is False
    assert "AI_PROVIDER" in status["reason"]


def test_anthropic_without_key(monkeypatch):
    monkeypatch.setattr(providers.settings, "ai_provider", "anthropic")
    monkeypatch.setattr(providers.settings, "anthropic_api_key", "")
    with pytest.raises(providers.ProviderNotConfigured, match="ANTHROPIC_API_KEY"):
        providers.get_provider()


def test_phase7_stubs_report_unconfigured(monkeypatch):
    monkeypatch.setattr(providers.settings, "ai_provider", "ollama")
    status = providers.provider_status()
    assert status["configured"] is False
    assert "Phase 7" in status["reason"]


def test_unknown_provider(monkeypatch):
    monkeypatch.setattr(providers.settings, "ai_provider", "hal9000")
    with pytest.raises(providers.ProviderNotConfigured, match="Unknown"):
        providers.get_provider()
