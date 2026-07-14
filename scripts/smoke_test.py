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
            data={
                "grant_type": "client_credentials",
                "client_id": cid,
                "client_secret": secret,
            },
            timeout=10,
        )
        assert resp.status_code == 200, f"status {resp.status_code}: {resp.text[:200]}"
        token["value"] = resp.json()["access_token"]

    def auth_headers() -> dict:
        return {
            "Authorization": f"Bearer {token['value']}",
            "Content-Type": "application/fhir+json",
        }

    def read_patient():
        ident = env("HMD_PATIENT_IDENTIFIER", "healmedaily-user")
        resp = httpx.get(
            base + "fhir/R4/Patient",
            params={
                "identifier": f"https://healmedaily.local/fhir/identifier/patient|{ident}",
                "_count": 1,
            },
            headers=auth_headers(),
            timeout=10,
        )
        assert resp.status_code == 200, f"status {resp.status_code}"
        entries = resp.json().get("entry") or []
        assert entries, "patient not found (run make seed)"
        return f"Patient/{entries[0]['resource']['id']}"

    def write_read_delete_observation():
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        ident = env("HMD_PATIENT_IDENTIFIER", "healmedaily-user")
        patient = httpx.get(
            base + "fhir/R4/Patient",
            params={
                "identifier": f"https://healmedaily.local/fhir/identifier/patient|{ident}",
                "_count": 1,
            },
            headers=auth_headers(),
            timeout=10,
        ).json()["entry"][0]["resource"]
        resp = httpx.post(
            base + "fhir/R4/Observation",
            json={
                "resourceType": "Observation",
                "status": "final",
                "subject": {"reference": f"Patient/{patient['id']}"},
                "code": {
                    "coding": [
                        {
                            "system": "https://healmedaily.local/fhir/CodeSystem/observation",
                            "code": "smoke-test",
                        }
                    ],
                    "text": "Smoke test",
                },
                "valueString": f"smoke {now}",
            },
            headers=auth_headers(),
            timeout=10,
        )
        assert resp.status_code == 201, (
            f"create status {resp.status_code}: {resp.text[:200]}"
        )
        obs_id = resp.json()["id"]
        try:
            resp = httpx.get(
                base + f"fhir/R4/Observation/{obs_id}",
                headers=auth_headers(),
                timeout=10,
            )
            assert resp.status_code == 200, f"read-back status {resp.status_code}"
            assert resp.json()["valueString"] == f"smoke {now}", (
                "read-back value mismatch"
            )
        finally:
            # never leave smoke artifacts in the record, even on failure
            resp = httpx.delete(
                base + f"fhir/R4/Observation/{obs_id}",
                headers=auth_headers(),
                timeout=10,
            )
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
        assert resp.status_code == 200, (
            f"main.tsx transform failed: status {resp.status_code} {resp.text[:200]}"
        )

    def check_ingest_queue():
        resp = httpx.get(ai_base + "ingest/tasks", timeout=15)
        assert resp.status_code == 200, f"status {resp.status_code}: {resp.text[:200]}"
        assert isinstance(resp.json(), list), "expected a list of review tasks"
        return f"{len(resp.json())} task(s) awaiting review"

    def check_health_review_endpoint():
        health = httpx.get(ai_base + "health", timeout=5).json()
        configured = health.get("ai", {}).get("configured")
        latest = httpx.get(ai_base + "health-review/latest", timeout=15)
        assert latest.status_code in (200, 404), (
            f"latest: {latest.status_code} {latest.text[:200]}"
        )
        if not configured:
            # Without a provider the endpoint must refuse politely, not crash.
            resp = httpx.post(
                ai_base + "health-review", json={"window_days": 30}, timeout=15
            )
            assert resp.status_code == 503, (
                f"expected 503 without provider, got {resp.status_code}"
            )
            return "no provider configured — graceful 503 verified"
        return f"provider configured ({health['ai'].get('provider')}); latest={latest.status_code}"

    def check_bot_roundtrip():
        import time
        import uuid

        marker = str(uuid.uuid4())
        patient = httpx.get(
            base + "fhir/R4/Patient",
            params={
                "identifier": f"https://healmedaily.local/fhir/identifier/patient|{env('HMD_PATIENT_IDENTIFIER', 'healmedaily-user')}"
            },
            headers=auth_headers(),
            timeout=10,
        ).json()["entry"][0]["resource"]
        qr = httpx.post(
            base + "fhir/R4/QuestionnaireResponse",
            json={
                "resourceType": "QuestionnaireResponse",
                "status": "completed",
                "questionnaire": "https://healmedaily.local/fhir/Questionnaire/daily-check-in",
                "subject": {"reference": f"Patient/{patient['id']}"},
                "authored": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "item": [{"linkId": "mood", "answer": [{"valueInteger": 7}]}],
                "identifier": {
                    "system": "https://healmedaily.local/fhir/identifier/questionnaire-response",
                    "value": f"smoke-{marker}",
                },
            },
            headers=auth_headers(),
            timeout=10,
        )
        assert qr.status_code == 201, f"QR create: {qr.status_code} {qr.text[:200]}"
        qr_id = qr.json()["id"]
        obs_ident = f"https://healmedaily.local/fhir/identifier/questionnaire-observation|{qr_id}-mood"
        obs_id = None
        try:
            for _ in range(20):
                time.sleep(1.5)
                found = httpx.get(
                    base + "fhir/R4/Observation",
                    params={"identifier": obs_ident, "_count": 1},
                    headers=auth_headers(),
                    timeout=10,
                ).json()
                if found.get("entry"):
                    obs_id = found["entry"][0]["resource"]["id"]
                    break
            assert obs_id, "bot did not create the derived Observation within 30s"
            return f"QR {qr_id} -> Observation {obs_id}"
        finally:
            # keep smoke runs from polluting the record
            if obs_id:
                httpx.delete(
                    base + f"fhir/R4/Observation/{obs_id}",
                    headers=auth_headers(),
                    timeout=10,
                )
            httpx.delete(
                base + f"fhir/R4/QuestionnaireResponse/{qr_id}",
                headers=auth_headers(),
                timeout=10,
            )

    def check_followup_bot():
        import time
        import uuid as uuid_mod

        obs = httpx.post(
            base + "fhir/R4/Observation",
            json={
                "resourceType": "Observation",
                "status": "final",
                "code": {
                    "coding": [
                        {
                            "system": "https://healmedaily.local/fhir/CodeSystem/observation",
                            "code": "symptom",
                        }
                    ],
                    "text": "Symptom",
                },
                "subject": {"reference": f"Patient/{env('MEDPLUM_PATIENT_ID')}"},
                "effectiveDateTime": datetime.now(timezone.utc).isoformat(
                    timespec="seconds"
                ),
                "valueString": f"smoke symptom {uuid_mod.uuid4()}",
            },
            headers=auth_headers(),
            timeout=10,
        ).json()
        ident = f"https://healmedaily.local/fhir/identifier/task|symptom-follow-up-{obs['id']}"
        task_id = None
        try:
            for _ in range(20):
                time.sleep(1.5)
                found = httpx.get(
                    base + "fhir/R4/Task",
                    params={"identifier": ident},
                    headers=auth_headers(),
                    timeout=10,
                ).json()
                if found.get("entry"):
                    task_id = found["entry"][0]["resource"]["id"]
                    break
            assert task_id, "follow-up Task did not appear within 30s"
            return f"Observation {obs['id']} -> Task {task_id}"
        finally:
            if task_id:
                httpx.delete(
                    base + f"fhir/R4/Task/{task_id}", headers=auth_headers(), timeout=10
                )
            httpx.delete(
                base + f"fhir/R4/Observation/{obs['id']}",
                headers=auth_headers(),
                timeout=10,
            )

    step("medplum /healthcheck", check_server)
    step("ai-service /health", check_ai_health)
    step("oauth2 client-credentials token", get_token)
    step("FHIR read: Patient by identifier", read_patient)
    step("FHIR write+read+delete: Observation", write_read_delete_observation)
    step("ai-service -> Medplum round-trip", check_ai_medplum_roundtrip)
    step("frontend dev server", check_frontend)
    step("ingestion review queue endpoint", check_ingest_queue)
    step(
        "health-review endpoint (graceful without provider)",
        check_health_review_endpoint,
    )

    def check_csv_import():
        import uuid as uuid_mod

        marker = uuid_mod.uuid4().hex[:8]
        csv_text = (
            "id,effective,code_system,code,display,value,unit,status,category\n"
            f"x,2026-01-01T08:00:00Z,https://healmedaily.local/fhir/CodeSystem/observation,"
            f"smoke-import-{marker},Smoke import,42,,final,survey\n"
        )
        files = {"file": ("smoke.csv", csv_text, "text/csv")}
        first = httpx.post(ai_base + "import/csv", files=files, timeout=30)
        assert first.status_code == 200, (
            f"import: {first.status_code} {first.text[:200]}"
        )
        assert first.json()["imported"] == 1, f"expected 1 imported: {first.json()}"
        second = httpx.post(ai_base + "import/csv", files=files, timeout=30)
        assert second.json()["already_existed"] == 1, (
            f"re-import should dedup: {second.json()}"
        )
        found = httpx.get(
            base + "fhir/R4/Observation",
            params={"code": f"smoke-import-{marker}", "_count": 5},
            headers=auth_headers(),
            timeout=10,
        ).json()
        entries = found.get("entry", [])
        assert len(entries) == 1, (
            f"expected exactly 1 imported observation, got {len(entries)}"
        )
        httpx.delete(
            base + f"fhir/R4/Observation/{entries[0]['resource']['id']}",
            headers=auth_headers(),
            timeout=10,
        )
        return "1 imported, re-import deduped"

    step("bot: QuestionnaireResponse -> Observation", check_bot_roundtrip)
    step("bot: symptom -> follow-up Task", check_followup_bot)
    step("import: CSV round-trip with dedup", check_csv_import)

    if FAILED:
        print("[smoke] RESULT: FAIL")
        sys.exit(1)
    print("[smoke] RESULT: PASS — walking skeleton is healthy")


if __name__ == "__main__":
    main()
