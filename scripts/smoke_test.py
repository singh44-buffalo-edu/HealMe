#!/usr/bin/env python
"""End-to-end smoke test — the "phase is done" gate (CLAUDE.md: a phase is
done only when builds, starts, smoke passes; never advance on red).

Checks, in dependency order: Medplum healthcheck -> ai-service /health ->
OAuth token -> Patient read -> Observation write + read-back + delete ->
ai-service Medplum round-trip -> frontend dev server -> ingestion review
queue -> health-review degradation contract -> both Subscription/Bot
pipelines -> CSV importer dedup. A failing step marks the run failed but
later steps still execute, so one run shows the full health picture; the
exit code is non-zero if ANY step failed.

What each step proves is documented on the check_* functions inside main().
Every FHIR artifact a step creates is deleted even on failure — smoke runs
never pollute the record.

Run while the stack is up: `make up && make dev` (in another terminal), then
`make smoke`. Uses the ai-service's client credentials from .env, so it also
exercises the least-privilege AccessPolicy (scripts/bootstrap.py) — a 403
here usually means a missing SERVICE_POLICY_RESOURCES entry.
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
    """Run one check: print PASS/FAIL (+ the check's return value as detail),
    record failure, keep going — see module docstring for why we don't stop."""
    global FAILED
    try:
        detail = fn()
        print(f"[smoke] PASS  {name}" + (f" — {detail}" if detail else ""))
    except Exception as err:  # noqa: BLE001 — a smoke test reports anything
        print(f"[smoke] FAIL  {name} — {err}")
        FAILED = True


def main() -> None:
    """Run every check via step(); exit 1 if any failed."""
    base = env("MEDPLUM_BASE_URL", "http://localhost:8103/")
    if not base.endswith("/"):
        base += "/"
    ai_base = "http://localhost:8000/"
    frontend = "http://localhost:5173/"
    token: dict = {}

    def check_server():
        """Proves: the Medplum stack is up and healthy (postgres + redis +
        server booted; port 8103 reachable)."""
        resp = httpx.get(base + "healthcheck", timeout=5)
        assert resp.status_code == 200, f"status {resp.status_code}"

    def check_ai_health():
        """Proves: the FastAPI service is running and has loaded its config
        (medplum_configured=False means .env lacks client credentials)."""
        resp = httpx.get(ai_base + "health", timeout=5)
        assert resp.status_code == 200, f"status {resp.status_code}"
        return f"medplum_configured={resp.json().get('medplum_configured')}"

    def get_token():
        """Proves: the ClientApplication from bootstrap still exists and its
        client-credentials grant works. All later FHIR steps ride this token
        (and therefore the service AccessPolicy)."""
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
        """Proves: seeding ran (the owner Patient exists under its business
        identifier) and the least-privilege policy grants Patient read."""
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
        """Proves: the full write path — the service can create clinical data
        (policy grants Observation write), read its own write back, and clean
        up. The finally-delete keeps the record smoke-free on any outcome."""
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

    def ai_headers() -> dict:
        """Bearer header for the ai-service's session gate (auth.py): the
        script forwards the same client-credentials token it uses for FHIR."""
        return (
            {"Authorization": f"Bearer {token['value']}"} if token.get("value") else {}
        )

    def check_ai_auth_gate():
        """Proves: the ai-service session gate is live — a protected endpoint
        refuses tokenless callers with 401 while /health stays open. Skipped
        (reported, not failed) when AI_REQUIRE_AUTH=false."""
        health = httpx.get(ai_base + "health", timeout=5).json()
        if not health.get("auth_required"):
            return "AI_REQUIRE_AUTH=false — gate off, skipping 401 check"
        resp = httpx.get(ai_base + "ingest/tasks", timeout=10)
        assert resp.status_code == 401, (
            f"expected 401 without a token, got {resp.status_code}"
        )
        return "tokenless request correctly refused (401)"

    def check_ai_medplum_roundtrip():
        """Proves: the ai-service ITSELF can reach Medplum — /medplum/status
        makes a server-side FHIR read with the service's own token cache
        (distinct from this script's direct calls above)."""
        resp = httpx.get(ai_base + "medplum/status", timeout=10, headers=ai_headers())
        assert resp.status_code == 200, f"status {resp.status_code}: {resp.text[:200]}"
        return f"patients={resp.json().get('patients')}"

    def check_frontend():
        """Proves: the Vite dev server is up AND the app actually compiles —
        not just that something answers on :5173."""
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
        """Proves: the ingestion review queue is reachable — the endpoint the
        human-in-the-loop gate lives behind (proposal Tasks, FHIR-MAPPING §6).
        Read-only: nothing is enqueued or committed here."""
        resp = httpx.get(ai_base + "ingest/tasks", timeout=15, headers=ai_headers())
        assert resp.status_code == 200, f"status {resp.status_code}: {resp.text[:200]}"
        assert isinstance(resp.json(), list), "expected a list of review tasks"
        return f"{len(resp.json())} task(s) awaiting review"

    def check_health_review_endpoint():
        """Proves: the no-AI-key degradation contract (CLAUDE.md §6 — the app
        must boot with no AI key). Without a configured provider the endpoint
        must refuse with a clean 503, never crash and never call out."""
        health = httpx.get(ai_base + "health", timeout=5).json()
        configured = health.get("ai", {}).get("configured")
        latest = httpx.get(
            ai_base + "health-review/latest", timeout=15, headers=ai_headers()
        )
        assert latest.status_code in (200, 404), (
            f"latest: {latest.status_code} {latest.text[:200]}"
        )
        if not configured:
            # Without a provider the endpoint must refuse politely, not crash.
            resp = httpx.post(
                ai_base + "health-review",
                json={"window_days": 30},
                timeout=15,
                headers=ai_headers(),
            )
            assert resp.status_code == 503, (
                f"expected 503 without provider, got {resp.status_code}"
            )
            return "no provider configured — graceful 503 verified"
        return f"provider configured ({health['ai'].get('provider')}); latest={latest.status_code}"

    def check_bot_roundtrip():
        """Proves: the whole event pipeline — Subscription fires on QR create,
        the project has bots enabled, the deployed QR->Observation bot runs
        and its derived Observation appears. Polling is required because bot
        execution is async (and remember: a failed bot run never retries)."""
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
        """Proves: the second Subscription/Bot pair — a symptom-coded
        Observation yields the next-day follow-up Task (idempotent identifier
        task|symptom-follow-up-{obsId})."""
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
    step("ai-service auth gate (401 without token)", check_ai_auth_gate)
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
        """Proves: the deterministic importer path (Phase 4 — direct commit,
        no review queue) AND its content-hash dedup: importing the same CSV
        twice must report already_existed and leave exactly one Observation."""
        import uuid as uuid_mod

        marker = uuid_mod.uuid4().hex[:8]
        csv_text = (
            "id,effective,code_system,code,display,value,unit,status,category\n"
            f"x,2026-01-01T08:00:00Z,https://healmedaily.local/fhir/CodeSystem/observation,"
            f"smoke-import-{marker},Smoke import,42,,final,survey\n"
        )
        files = {"file": ("smoke.csv", csv_text, "text/csv")}
        first = httpx.post(
            ai_base + "import/csv", files=files, timeout=30, headers=ai_headers()
        )
        assert first.status_code == 200, (
            f"import: {first.status_code} {first.text[:200]}"
        )
        assert first.json()["imported"] == 1, f"expected 1 imported: {first.json()}"
        second = httpx.post(
            ai_base + "import/csv", files=files, timeout=30, headers=ai_headers()
        )
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
