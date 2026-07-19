"""Shared test setup.

The bearer-token gate (app/auth.py) defaults ON, but almost every endpoint
test predates it and exercises domain behavior, not authentication — so the
gate is switched off for the whole suite here. test_auth.py re-enables it
explicitly to test the gate itself.
"""

import pytest

from app.config import settings


@pytest.fixture(autouse=True)
def _auth_gate_off(monkeypatch):
    monkeypatch.setattr(settings, "ai_require_auth", False)
