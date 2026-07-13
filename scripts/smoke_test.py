#!/usr/bin/env python
"""End-to-end smoke test for the walking skeleton.

Checks: Medplum healthcheck -> ai-service /health -> OAuth token -> Patient
read -> Observation write + read-back + delete -> ai-service Medplum
round-trip -> frontend dev server. Exits non-zero on the first failure.

Run while the stack is up: `make up && make dev` (in another terminal), then
`make smoke`.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import dotenv_values

REPO = Path(__file__).resolve().parents[1]
ENV = dotenv_values(REPO / ".env")

FAILED = False


def env(key: str, default: str = "") -> str:
    return (ENV.get(key) or default).strip()


def step(name: str, fn):
    global FAILED
    try:
        detail = fn()
        print(f"[smoke] PASS  {name}" + (f" — {detail}" if detail else ""))
    except Exception as err:  # noqa: BLE001 — a smoke test reports anything
        print(f"[smoke] FAIL  {name} — {err}")
        FAILED = True


def main() -> None:
    base = env("MEDPLUM_BASE_URL", "http://localhost:8103/")
    if not base.endswith("/"):
        base += "/"
    ai_base = "http://localhost:8000/"
    frontend = "http://localhost:5173/"
    token: dict = {}

    def check_server():
        resp = httpx.get(base + "healthcheck", timeout=5)
        assert resp.status_code == 200, f"status {resp.status_code}"

    def check_ai_health():
        resp = httpx.get(ai_base + "health", timeout=5)
        assert resp.status_code == 200, f"status {resp.status_code}"
        return f"medplum_configured={resp.json().get('medplum_configured')}"

    def get_token():
        cid, secret = env("MEDPLUM_CLIENT_ID"), env("MEDPLUM_CLIENT_SECRET")
        assert cid and secret, "no client credentials in .env (run make bootstrap)"
        resp = httpx.post(
            base + "oauth2/token",
            data={"grant_type": "client_credentials", "client_id": cid, "client_secret": secret},
            timeout=10,
        )
        assert resp.status_code == 200, f"status {resp.status_code}: {resp.text[:200]}"
        token["value"] = resp.json()["access_token"]

    def auth_headers() -> dict:
        return {"Authorization": f"Bearer {token['value']}", "Content-Type": "application/fhir+json"}

    def read_patient():
        ident = env("HMD_PATIENT_IDENTIFIER", "healmedaily-user")
        resp = httpx.get(
            base + "fhir/R4/Patient",
            params={"identifier": f"https://healmedaily.local/fhir/identifier/patient|{ident}", "_count": 1},
            headers=auth_headers(),
            timeout=10,
        )
        assert resp.status_code == 200, f"status {resp.status_code}"
        entries = resp.json().get("entry") or []
        assert entries, "patient not found (run make seed)"
        return f"Patient/{entries[0]['resource']['id']}"

    def write_read_delete_observation():
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        resp = httpx.post(
            base + "fhir/R4/Observation",
            json={
                "resourceType": "Observation",
                "status": "final",
                "code": {
                    "coding": [
                        {"system": "https://healmedaily.local/fhir/CodeSystem/observation", "code": "smoke-test"}
                    ],
                    "text": "Smoke test",
                },
                "valueString": f"smoke {now}",
            },
            headers=auth_headers(),
            timeout=10,
        )
        assert resp.status_code == 201, f"create status {resp.status_code}: {resp.text[:200]}"
        obs_id = resp.json()["id"]
        resp = httpx.get(base + f"fhir/R4/Observation/{obs_id}", headers=auth_headers(), timeout=10)
        assert resp.status_code == 200, f"read-back status {resp.status_code}"
        assert resp.json()["valueString"] == f"smoke {now}", "read-back value mismatch"
        resp = httpx.delete(base + f"fhir/R4/Observation/{obs_id}", headers=auth_headers(), timeout=10)
        assert resp.status_code in (200, 204), f"delete status {resp.status_code}"
        return f"Observation/{obs_id} created+verified+deleted"

    def check_ai_medplum_roundtrip():
        resp = httpx.get(ai_base + "medplum/status", timeout=10)
        assert resp.status_code == 200, f"status {resp.status_code}: {resp.text[:200]}"
        return f"patients={resp.json().get('patients')}"

    def check_frontend():
        resp = httpx.get(frontend, timeout=5)
        assert resp.status_code == 200, f"status {resp.status_code}"
        assert "HealMeDaily" in resp.text, "index.html does not look like the app"
        # index.html alone can 200 while the module graph is broken — ask Vite
        # to actually transform the entry module.
        resp = httpx.get(frontend + "src/main.tsx", timeout=30)
        assert resp.status_code == 200, f"main.tsx transform failed: status {resp.status_code} {resp.text[:200]}"

    step("medplum /healthcheck", check_server)
    step("ai-service /health", check_ai_health)
    step("oauth2 client-credentials token", get_token)
    step("FHIR read: Patient by identifier", read_patient)
    step("FHIR write+read+delete: Observation", write_read_delete_observation)
    step("ai-service -> Medplum round-trip", check_ai_medplum_roundtrip)
    step("frontend dev server", check_frontend)

    if FAILED:
        print("[smoke] RESULT: FAIL")
        sys.exit(1)
    print("[smoke] RESULT: PASS — walking skeleton is healthy")


if __name__ == "__main__":
    main()
