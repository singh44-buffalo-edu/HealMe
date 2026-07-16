#!/usr/bin/env python
"""Deploy bots to the local Medplum and wire their Subscriptions.

Run via `make bots` (which builds backend-bots first — each bot bundles to
one dist/*.js via esbuild). The BOTS table below is the single source of
wiring truth: name/description, built file, and EITHER a Subscription
definition (event-triggered) OR subscription=None (+ optional cron string).

Idempotent: enables the project 'bots'/'cron' features, creates each Bot once
(found by name), re-deploys its built code every run (that is how code
changes ship), and creates the triggering Subscription once.

⚠️ Bot-endpoint Subscriptions execute once and NEVER retry (CLAUDE.md §5) —
every bot registered here must be idempotent (stable identifiers +
conditional creates; see the headers in backend-bots/src/*.ts) and
non-critical to data integrity.

Run `npm run build --prefix backend-bots` first (or via `make bots`).
Requires admin credentials in .env (from scripts/bootstrap.py), and the
instance super admin for the one-time feature flip (see .env.example).
"""

from __future__ import annotations

import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent))
from bootstrap import env, password_login  # noqa: E402

REPO = Path(__file__).resolve().parents[1]

# Subscription criteria are FHIR search strings; supported_interaction maps to
# Medplum's subscription-supported-interaction extension (one valueCode only)
# so update-storms don't re-fire create-triggered bots.
BOTS = [
    {
        # Fans check-in answers out to chartable Observations (FHIR-MAPPING §4).
        "name": "questionnaire-response-to-observations",
        "description": "Fans numeric check-in answers out to Observations",
        "dist": REPO / "backend-bots/dist/questionnaire-response-to-observations.js",
        "subscription": {
            "reason": "Run questionnaire-response-to-observations on new check-ins",
            "criteria": "QuestionnaireResponse",
            "supported_interaction": "create",
        },
    },
    {
        # Next-day check-back Task per symptom; criteria filter on the local
        # symptom code so ordinary Observations never invoke the bot.
        "name": "symptom-follow-up",
        "description": "Creates a next-day follow-up Task when a symptom is logged",
        "dist": REPO / "backend-bots/dist/symptom-follow-up.js",
        "subscription": {
            "reason": "Schedule a follow-up when a symptom Observation is created",
            "criteria": "Observation?code=https://healmedaily.local/fhir/CodeSystem/observation|symptom",
            "supported_interaction": "create",
        },
    },
    {
        # On-demand ($execute with a Parameters input) — no Subscription.
        "name": "break-glass",
        "description": "Care-circle break-glass: swap a member to the 24h emergency policy and back",
        "dist": REPO / "backend-bots/dist/break-glass.js",
        "subscription": None,
    },
    {
        # Cron bot — no Subscription; Medplum invokes it on the schedule below
        # (every 15 min). Each run rescans from scratch, so missed ticks are
        # harmless; it never writes dose status (medical-safety rule).
        "name": "reminders-runner",
        "description": "Overdue unlogged dose slots -> CommunicationRequest reminders (display-only)",
        "dist": REPO / "backend-bots/dist/reminders-runner.js",
        "subscription": None,
        "cron": "*/15 * * * *",
    },
]


def log(msg: str) -> None:
    print(f"[deploy-bots] {msg}")


def die(msg: str) -> None:
    print(f"[deploy-bots] FATAL: {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    """Ensure features, then for each bot: ensure resource -> deploy code ->
    wire cron or Subscription. Any HTTP failure aborts (die-fast)."""
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
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/fhir+json",
    }

    # 1. Ensure the project has the needed features enabled ('bots' to run
    # bots at all, 'cron' for schedule-triggered bots). Project.features is a
    # super-admin-protected field: a normal project admin's PUT silently
    # strips it, so this step uses the instance super admin (seeded by the
    # server on first boot; change its password during hardening).
    project = httpx.get(
        base + f"fhir/R4/Project/{project_id}", headers=headers, timeout=15
    )
    if project.status_code >= 400:
        die(
            f"cannot read Project/{project_id}: {project.status_code} {project.text[:200]}"
        )
    proj = project.json()
    needed = {"bots", "cron"} - set(proj.get("features", []))
    if needed:
        sa_email = env("HMD_SUPERADMIN_EMAIL", "admin@example.com")
        sa_password = env("HMD_SUPERADMIN_PASSWORD", "medplum_admin")
        sa_token = password_login(base, sa_email, sa_password)
        if not sa_token:
            die("super admin login failed — set HMD_SUPERADMIN_EMAIL/PASSWORD in .env")
        sa_headers = {
            "Authorization": f"Bearer {sa_token}",
            "Content-Type": "application/fhir+json",
        }
        proj["features"] = proj.get("features", []) + sorted(needed)
        resp = httpx.put(
            base + f"fhir/R4/Project/{project_id}",
            json=proj,
            headers=sa_headers,
            timeout=15,
        )
        if resp.status_code >= 400:
            die(f"enabling features failed: {resp.status_code} {resp.text[:300]}")
        check = httpx.get(
            base + f"fhir/R4/Project/{project_id}", headers=headers, timeout=15
        ).json()
        if needed - set(check.get("features", [])):
            die("features did not persist — investigate super admin permissions")
        log(f"enabled {sorted(needed)} feature(s) on project (as super admin)")

    for bot_def in BOTS:
        name = bot_def["name"]
        dist: Path = bot_def["dist"]
        if not dist.exists():
            die(f"{dist} missing — run `npm run build --prefix backend-bots`")
        code = dist.read_text()

        # 2. Ensure the Bot resource exists
        found = httpx.get(
            base + "fhir/R4/Bot",
            params={"name": name, "_count": 1},
            headers=headers,
            timeout=15,
        )
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

        # 4. Cron wiring (cron bots have no Subscription; Medplum's scheduler
        # invokes them per Bot.cronString — requires the 'cron' project feature)
        cron = bot_def.get("cron")
        if cron:
            bot_res = httpx.get(
                base + f"fhir/R4/Bot/{bot_id}", headers=headers, timeout=15
            ).json()
            if bot_res.get("cronString") != cron:
                bot_res["cronString"] = cron
                resp = httpx.put(
                    base + f"fhir/R4/Bot/{bot_id}",
                    json=bot_res,
                    headers=headers,
                    timeout=15,
                )
                if resp.status_code >= 400:
                    die(f"cron wiring failed: {resp.status_code} {resp.text[:300]}")
                log(f"set cronString '{cron}' on Bot/{bot_id}")
            else:
                log(f"cronString '{cron}' already set on Bot/{bot_id}")

        # 5. Ensure the Subscription exists (event-triggered bots only)
        sub_def = bot_def["subscription"]
        if sub_def is None:
            continue
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
                    "channel": {
                        "type": "rest-hook",
                        "endpoint": endpoint,
                        "payload": "application/fhir+json",
                    },
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
