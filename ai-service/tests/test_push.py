"""Push subsystem: token store, the shared-secret dispatch gate, the no-PHI
payload contract, and graceful "APNs not configured" behavior."""

import json

import pytest
from fastapi.testclient import TestClient

from app import apns, pushstore
from app.config import settings
from app.main import app


@pytest.fixture(autouse=True)
def _isolate_store(tmp_path, monkeypatch):
    # Never touch the real data/secrets during tests.
    monkeypatch.setattr(pushstore, "SECRETS_DIR", tmp_path)
    apns.reset_token_cache()


@pytest.fixture()
def client(monkeypatch):
    # /push/register is session-gated; keep the gate off for these tests (the
    # gate itself is covered in test_auth). /push/dispatch is gate-exempt.
    monkeypatch.setattr(settings, "ai_require_auth", False)
    return TestClient(app)


CS_MEDIUM = "https://healmedaily.local/fhir/CodeSystem/communication-medium"


def push_cr(cr_id="cr1"):
    return {
        "resourceType": "CommunicationRequest",
        "id": cr_id,
        "status": "active",
        "medium": [{"coding": [{"system": CS_MEDIUM, "code": "push"}]}],
        "about": [{"reference": "MedicationRequest/abc"}],
        # The med name lives here — the dispatcher must NOT forward it.
        "payload": [{"contentString": "Dose reminder: Lisinopril scheduled for 09:00 not logged yet."}],
    }


# --- Token store -----------------------------------------------------------


def test_register_and_remove_token():
    pushstore.register_token("tok-1", "sandbox", "2026-07-17T00:00:00Z")
    pushstore.register_token("tok-1", "sandbox", "2026-07-17T01:00:00Z")  # dedup
    pushstore.register_token("tok-2", "production", "2026-07-17T00:00:00Z")
    tokens = pushstore.all_tokens()
    assert set(tokens) == {"tok-1", "tok-2"}
    assert tokens["tok-1"]["environment"] == "sandbox"
    pushstore.remove_token("tok-1")
    assert set(pushstore.all_tokens()) == {"tok-2"}
    pushstore.remove_token("absent")  # idempotent


def test_register_endpoint(client):
    resp = client.post("/push/register", json={"device_token": "abc", "environment": "sandbox"})
    assert resp.status_code == 200
    assert resp.json()["registered"] is True
    assert "abc" in pushstore.all_tokens()


def test_unregister_keeps_token_out_of_url(client):
    pushstore.register_token("abc", "production", "t")
    resp = client.post("/push/unregister", json={"device_token": "abc"})
    assert resp.status_code == 200
    assert "abc" not in pushstore.all_tokens()


# --- Dispatch auth ---------------------------------------------------------


def test_dispatch_requires_secret(client, monkeypatch):
    monkeypatch.setattr(settings, "push_subscription_secret", "s3cret")
    resp = client.post("/push/dispatch", json=push_cr())
    assert resp.status_code == 401
    resp = client.post("/push/dispatch", json=push_cr(), headers={"Authorization": "Bearer wrong"})
    assert resp.status_code == 401


def test_dispatch_refuses_when_secret_unset(client, monkeypatch):
    monkeypatch.setattr(settings, "push_subscription_secret", "")
    resp = client.post("/push/dispatch", json=push_cr(), headers={"Authorization": "Bearer anything"})
    assert resp.status_code == 503


def test_dispatch_not_configured_is_graceful(client, monkeypatch):
    # Valid secret, a real push CR, but APNs unconfigured → 200 + skipped,
    # never a 500 that would drive the Subscription into retries.
    monkeypatch.setattr(settings, "push_subscription_secret", "s3cret")
    monkeypatch.setattr(apns, "configured", lambda: False)
    resp = client.post("/push/dispatch", json=push_cr(), headers={"Authorization": "Bearer s3cret"})
    assert resp.status_code == 200
    assert resp.json()["skipped"] == "APNs not configured"


def test_dispatch_ignores_non_push_and_inactive(client, monkeypatch):
    monkeypatch.setattr(settings, "push_subscription_secret", "s3cret")
    monkeypatch.setattr(apns, "configured", lambda: True)
    headers = {"Authorization": "Bearer s3cret"}
    completed = push_cr()
    completed["status"] = "completed"
    assert client.post("/push/dispatch", json=completed, headers=headers).json()["sent"] == 0
    no_push = push_cr()
    no_push["medium"] = [{"coding": [{"system": CS_MEDIUM, "code": "chime"}]}]
    assert client.post("/push/dispatch", json=no_push, headers=headers).json()["sent"] == 0


def test_dispatch_sends_generic_payload_and_dedups(client, monkeypatch):
    monkeypatch.setattr(settings, "push_subscription_secret", "s3cret")
    monkeypatch.setattr(apns, "configured", lambda: True)
    pushstore.register_token("tok-1", "sandbox", "t")
    sent_payloads = []

    async def fake_send(device_token, environment, title, body, data):
        sent_payloads.append({"title": title, "body": body, "data": data})
        return apns.SendResult(ok=True, status=200, should_prune=False)

    monkeypatch.setattr(apns, "send", fake_send)
    headers = {"Authorization": "Bearer s3cret"}

    resp = client.post("/push/dispatch", json=push_cr(), headers=headers)
    assert resp.json()["sent"] == 1
    # No PHI: the med name from the CR payload never appears anywhere.
    blob = json.dumps(sent_payloads)
    assert "Lisinopril" not in blob
    assert sent_payloads[0]["body"] == "You have a health reminder."
    assert sent_payloads[0]["data"] == {"target": "today", "kind": "dose-reminder"}

    # Same CR again → deduped, not re-sent.
    resp2 = client.post("/push/dispatch", json=push_cr(), headers=headers)
    assert resp2.json()["skipped"] == "already delivered"
    assert len(sent_payloads) == 1


def test_dispatch_prunes_dead_token(client, monkeypatch):
    monkeypatch.setattr(settings, "push_subscription_secret", "s3cret")
    monkeypatch.setattr(apns, "configured", lambda: True)
    pushstore.register_token("dead", "production", "t")

    async def fake_send(device_token, environment, title, body, data):
        return apns.SendResult(ok=False, status=410, should_prune=True, reason="Unregistered")

    monkeypatch.setattr(apns, "send", fake_send)
    resp = client.post("/push/dispatch", json=push_cr(), headers={"Authorization": "Bearer s3cret"})
    assert resp.json()["pruned"] == 1
    assert "dead" not in pushstore.all_tokens()


# --- APNs signer -----------------------------------------------------------


def test_apns_provider_token_is_es256_jwt(monkeypatch):
    # A generated EC P-256 key exercises the real signing path without any
    # Apple account. The JWT must have 3 parts and header alg ES256 / kid.
    import base64

    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.serialization import (
        Encoding,
        NoEncryption,
        PrivateFormat,
    )

    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()).decode()
    monkeypatch.setattr(settings, "apns_key_id", "KEY123")
    monkeypatch.setattr(settings, "apns_team_id", "TEAM123")
    monkeypatch.setattr(settings, "apns_bundle_id", "com.healmedaily.app")
    monkeypatch.setattr(settings, "apns_key_p8", pem)
    monkeypatch.setattr(settings, "apns_key_path", "")
    apns.reset_token_cache()

    assert apns.configured() is True
    token = apns._provider_token()
    header_b64, claims_b64, sig_b64 = token.split(".")
    header = json.loads(base64.urlsafe_b64decode(header_b64 + "=="))
    claims = json.loads(base64.urlsafe_b64decode(claims_b64 + "=="))
    assert header == {"alg": "ES256", "kid": "KEY123"}
    assert claims["iss"] == "TEAM123"
    # Raw R||S signature is 64 bytes.
    assert len(base64.urlsafe_b64decode(sig_b64 + "==")) == 64


def test_apns_not_configured_without_key():
    apns.reset_token_cache()
    assert apns.configured() is False
