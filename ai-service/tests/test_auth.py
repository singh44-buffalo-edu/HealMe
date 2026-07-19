"""Bearer-token gate (app/auth.py): fail-closed contract.

- /health stays reachable with no token (liveness must work pre-sign-in).
- Anything else without a token → 401.
- A token Medplum confirms → passes (and is cached).
- A token Medplum rejects → 401.
- Medplum unreachable during verification → 502, never a silent allow.
"""

import httpx
import pytest
from fastapi.testclient import TestClient

from app import auth
from app.config import settings
from app.main import app


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(settings, "ai_require_auth", True)
    auth._verified.clear()
    return TestClient(app)


def test_health_is_exempt(client):
    assert client.get("/health").status_code == 200


def test_missing_token_is_401(client):
    response = client.get("/ingest/tasks")
    assert response.status_code == 401
    assert "Sign in" in response.json()["detail"]


def test_malformed_header_is_401(client):
    response = client.get("/ingest/tasks", headers={"Authorization": "Basic abc"})
    assert response.status_code == 401


def test_valid_token_passes_and_caches(client, monkeypatch):
    calls = {"n": 0}

    async def fake_userinfo(token):
        calls["n"] += 1
        return {} if token == "good-token" else None

    monkeypatch.setattr(auth, "_userinfo", fake_userinfo)
    headers = {"Authorization": "Bearer good-token"}
    first = client.get("/ingest/tasks", headers=headers)
    second = client.get("/ingest/tasks", headers=headers)
    # The endpoint itself may 502 without a configured Medplum — the gate's
    # job is only to not 401 a verified session.
    assert first.status_code != 401
    assert second.status_code != 401
    assert calls["n"] == 1  # second request served from the verification cache


def test_rejected_token_is_401(client, monkeypatch):
    async def fake_userinfo(token):
        return None

    monkeypatch.setattr(auth, "_userinfo", fake_userinfo)
    response = client.get("/ingest/tasks", headers={"Authorization": "Bearer stale"})
    assert response.status_code == 401


def test_medplum_unreachable_is_502_not_allow(client, monkeypatch):
    async def fake_userinfo(token):
        raise httpx.ConnectError("boom")

    monkeypatch.setattr(auth, "_userinfo", fake_userinfo)
    response = client.get("/ingest/tasks", headers={"Authorization": "Bearer whatever"})
    assert response.status_code == 502


def test_non_owner_token_is_403_when_allowlist_set(client, monkeypatch):
    # Valid session, but AI_OWNER_PROFILES names someone else → 403, not cached.
    monkeypatch.setattr(settings, "ai_owner_profiles", "Practitioner/owner")

    async def fake_userinfo(token):
        return {"fhirUser": "https://host/fhir/R4/Practitioner/caretaker"}

    monkeypatch.setattr(auth, "_userinfo", fake_userinfo)
    resp = client.get("/ingest/tasks", headers={"Authorization": "Bearer scoped"})
    assert resp.status_code == 403


def test_owner_token_passes_when_allowlist_set(client, monkeypatch):
    monkeypatch.setattr(settings, "ai_owner_profiles", "Practitioner/owner, Patient/me")

    async def fake_userinfo(token):
        # fhirUser as an absolute URL must normalize to Type/id and match.
        return {"fhirUser": "https://host/fhir/R4/Practitioner/owner"}

    monkeypatch.setattr(auth, "_userinfo", fake_userinfo)
    resp = client.get("/ingest/tasks", headers={"Authorization": "Bearer owner"})
    assert resp.status_code != 401
    assert resp.status_code != 403


def test_no_allowlist_authenticates_only(client, monkeypatch):
    # Unset AI_OWNER_PROFILES ⇒ any valid session passes (single-user default).
    monkeypatch.setattr(settings, "ai_owner_profiles", "")

    async def fake_userinfo(token):
        return {"fhirUser": "Practitioner/anyone"}

    monkeypatch.setattr(auth, "_userinfo", fake_userinfo)
    resp = client.get("/ingest/tasks", headers={"Authorization": "Bearer anyone"})
    assert resp.status_code != 401
    assert resp.status_code != 403


def test_medplum_5xx_is_502_not_401(client, monkeypatch):
    # A Medplum outage (500) must not masquerade as an expired session — the
    # user would be told to "sign in again" during a server hiccup.
    calls = {"status": 500}

    class FakeResponse:
        status_code = calls["status"]

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, *a, **k):
            return FakeResponse()

    monkeypatch.setattr(auth.httpx, "AsyncClient", FakeClient)
    response = client.get("/ingest/tasks", headers={"Authorization": "Bearer live-but-medplum-down"})
    assert response.status_code == 502


def test_base_url_without_trailing_slash_hits_userinfo(client, monkeypatch):
    # urljoin against a slash-less base must not drop the host — verify the
    # exact URL the gate calls.
    seen = {}

    class FakeResponse:
        status_code = 200

        def json(self):
            return {}

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, *a, **k):
            seen["url"] = url
            return FakeResponse()

    monkeypatch.setattr(auth.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(auth.settings, "medplum_base_url", "http://localhost:8103")
    client.get("/ingest/tasks", headers={"Authorization": "Bearer t"})
    assert seen["url"] == "http://localhost:8103/oauth2/userinfo"
