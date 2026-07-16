"""Smoke-level check of GET /health: answers 200 with medplum/AI configured
flags on a machine with no .env, no Medplum and no AI key — the endpoint make
smoke and the frontend banner rely on."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_ok():
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "medplum_configured" in body
    assert "configured" in body["ai"]
