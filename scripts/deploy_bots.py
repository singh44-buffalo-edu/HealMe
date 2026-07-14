#!/usr/bin/env python
"""Deploy bots to the local Medplum and wire their Subscriptions.

Idempotent: enables the project 'bots' feature, creates each Bot once
(found by name), re-deploys its built code every run, and creates the
triggering Subscription once.

Run `npm run build --prefix backend-bots` first (or via `make bots`).
Requires admin credentials in .env (from scripts/bootstrap.py).
"""

from __future__ import annotations

import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent))
from bootstrap import env, password_login  # noqa: E402

REPO = Path(__file__).resolve().parents[1]

BOTS = [
    {
        "name": "questionnaire-response-to-observations",
        "description": "Fans numeric check-in answers out to Observations",
        "dist": REPO / "backend-bots/dist/questionnaire-response-to-observations.js",
        "subscription": {
            "reason": "Run questionnaire-response-to-observations on new check-ins",
            "criteria": "QuestionnaireResponse",
            "supported_interaction": "create",
        },
    }
]


def log(msg: str) -> None:
    print(f"[deploy-bots] {msg}")


def die(msg: str) -> None:
    print(f"[deploy-bots] FATAL: {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    base = env("MEDPLUM_BASE_URL", "http://localhost:8103/")
    if not base.endswith("/"):
        base += "/"
    project_id = env("MEDPLUM_PROJECT_ID")
    email, password = env("HMD_ADMIN_EMAIL"), env("HMD_ADMIN_PASSWORD")
    if not (project_id and email and password):
        die("missing admin credentials/project in .env — run `make bootstrap` first")

    token = password_login(base, email, password)
    if not token:
        die("admin login failed — check HMD_ADMIN_EMAIL/HMD_ADMIN_PASSWORD in .env")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/fhir+json"}

    # 1. Ensure the project has bots enabled. Project.features is a
    # super-admin-protected field: a normal project admin's PUT silently
    # strips it, so this step uses the instance super admin (seeded by the
    # server on first boot; change its password during hardening).
    project = httpx.get(base + f"fhir/R4/Project/{project_id}", headers=headers, timeout=15)
    if project.status_code >= 400:
        die(f"cannot read Project/{project_id}: {project.status_code} {project.text[:200]}")
    proj = project.json()
    if "bots" not in proj.get("features", []):
        sa_email = env("HMD_SUPERADMIN_EMAIL", "admin@example.com")
        sa_password = env("HMD_SUPERADMIN_PASSWORD", "medplum_admin")
        sa_token = password_login(base, sa_email, sa_password)
        if not sa_token:
            die("super admin login failed — set HMD_SUPERADMIN_EMAIL/PASSWORD in .env")
        sa_headers = {"Authorization": f"Bearer {sa_token}", "Content-Type": "application/fhir+json"}
        proj["features"] = proj.get("features", []) + ["bots"]
        resp = httpx.put(base + f"fhir/R4/Project/{project_id}", json=proj, headers=sa_headers, timeout=15)
        if resp.status_code >= 400:
            die(f"enabling bots feature failed: {resp.status_code} {resp.text[:300]}")
        check = httpx.get(base + f"fhir/R4/Project/{project_id}", headers=headers, timeout=15).json()
        if "bots" not in check.get("features", []):
            die("bots feature did not persist — investigate super admin permissions")
        log("enabled 'bots' feature on project (as super admin)")

    for bot_def in BOTS:
        name = bot_def["name"]
        dist: Path = bot_def["dist"]
        if not dist.exists():
            die(f"{dist} missing — run `npm run build --prefix backend-bots`")
        code = dist.read_text()

        # 2. Ensure the Bot resource exists
        found = httpx.get(base + "fhir/R4/Bot", params={"name": name, "_count": 1}, headers=headers, timeout=15)
        entries = found.json().get("entry", []) if found.status_code == 200 else []
        if entries:
            bot_id = entries[0]["resource"]["id"]
            log(f"bot '{name}' exists: Bot/{bot_id}")
        else:
            resp = httpx.post(
                base + f"admin/projects/{project_id}/bot",
                json={"name": name, "description": bot_def["description"]},
                headers=headers,
                timeout=15,
            )
            if resp.status_code >= 400:
                die(f"bot create failed: {resp.status_code} {resp.text[:300]}")
            bot_id = resp.json()["id"]
            log(f"created Bot/{bot_id}")

        # 3. Deploy current code (every run)
        resp = httpx.post(
            base + f"fhir/R4/Bot/{bot_id}/$deploy",
            json={"code": code, "filename": "index.js"},
            headers=headers,
            timeout=30,
        )
        if resp.status_code >= 400:
            die(f"bot deploy failed: {resp.status_code} {resp.text[:300]}")
        log(f"deployed code to Bot/{bot_id} ({len(code)} bytes)")

        # 4. Ensure the Subscription exists
        sub_def = bot_def["subscription"]
        endpoint = f"Bot/{bot_id}"
        subs = httpx.get(
            base + "fhir/R4/Subscription",
            params={"status": "active", "_count": 100},
            headers=headers,
            timeout=15,
        ).json()
        existing = [
            e
            for e in subs.get("entry", [])
            if e["resource"].get("criteria") == sub_def["criteria"]
            and e["resource"].get("channel", {}).get("endpoint") == endpoint
        ]
        if existing:
            log(f"subscription exists: Subscription/{existing[0]['resource']['id']}")
        else:
            resp = httpx.post(
                base + "fhir/R4/Subscription",
                json={
                    "resourceType": "Subscription",
                    "status": "active",
                    "reason": sub_def["reason"],
                    "criteria": sub_def["criteria"],
                    "channel": {"type": "rest-hook", "endpoint": endpoint, "payload": "application/fhir+json"},
                    "extension": [
                        {
                            "url": "https://medplum.com/fhir/StructureDefinition/subscription-supported-interaction",
                            "valueCode": sub_def["supported_interaction"],
                        }
                    ],
                },
                headers=headers,
                timeout=15,
            )
            if resp.status_code >= 400:
                die(f"subscription create failed: {resp.status_code} {resp.text[:300]}")
            log(f"created Subscription/{resp.json()['id']}")

    log("done")


if __name__ == "__main__":
    main()
