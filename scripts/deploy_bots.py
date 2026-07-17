#!/usr/bin/env python
"""Deploy bots to the local Medplum and wire their Subscriptions.

Run via `make bots` (which builds backend-bots first — each bot bundles to
one dist/*.js via esbuild). The BOTS table below is the single source of
wiring truth: name/description, built file, and EITHER a Subscription
definition (event-triggered) OR subscription=None (+ optional cron string).

Idempotent AND reconciling: enables the project 'bots'/'cron' features,
creates each Bot once (found by name), re-deploys its built code every run
(that is how code changes ship), keeps Bot.cronString/auditEventTrigger and
the bot's project-admin flag in line with the table, and reconciles the
triggering Subscription in place — editing a criteria/interaction here
updates the existing Subscription instead of leaving a stale duplicate
firing forever.

⚠️ Bot-endpoint Subscriptions execute once and NEVER retry (CLAUDE.md §5) —
every bot registered here must be idempotent (stable identifiers +
conditional creates/upserts; see the headers in backend-bots/src/*.ts) and
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

# Subscription criteria are FHIR search strings; supported_interactions maps
# to Medplum's subscription-supported-interaction extension (one valueCode
# per extension instance, multiple instances allowed) so update-storms don't
# re-fire bots that only care about creates.
# Optional per-bot knobs:
#   cron                — Bot.cronString; Medplum's scheduler invokes the bot.
#   audit_event_trigger — Bot.auditEventTrigger ('on-output' keeps the
#                         15-min cron ticks from writing ~35k success
#                         AuditEvents/year; the bots console.log only on
#                         meaningful runs). Verified after PUT — a server
#                         that strips the field gets a warning, not a crash.
#   project_admin       — set admin=true on the bot's ProjectMembership.
#                         ProjectMembership is a project-admin resource type,
#                         so a plain bot cannot read/update it (the server
#                         strips those types from non-admin policies).
BOTS = [
    {
        # Fans check-in answers out to chartable Observations (FHIR-MAPPING §4).
        # create AND update: the frontend edits a period's response in place,
        # and the bot upserts, so amendments re-derive instead of going stale.
        "name": "questionnaire-response-to-observations",
        "description": "Fans numeric check-in answers out to Observations",
        "dist": REPO / "backend-bots/dist/questionnaire-response-to-observations.js",
        "subscription": {
            "reason": "Run questionnaire-response-to-observations on new and amended check-ins",
            # status=completed: never invoke on an in-progress draft (the bot
            # also guards on status, but the criteria avoids the wasted run).
            "criteria": "QuestionnaireResponse?status=completed",
            "supported_interactions": ["create", "update"],
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
            "supported_interactions": ["create"],
        },
    },
    {
        # Two triggers, no Subscription: on-demand ($execute with a
        # Parameters/Communication input) for activate/restore, plus a 15-min
        # cron tick that carries no membership and therefore runs the bot's
        # expiry sweep — that sweep is what enforces the 24h window.
        "name": "break-glass",
        "description": "Care-circle break-glass: swap a member to the 24h emergency policy and back",
        "dist": REPO / "backend-bots/dist/break-glass.js",
        "subscription": None,
        "cron": "*/15 * * * *",
        "audit_event_trigger": "on-output",
        "project_admin": True,
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
        "audit_event_trigger": "on-output",
    },
]

SUPPORTED_INTERACTION_URL = (
    "https://medplum.com/fhir/StructureDefinition/subscription-supported-interaction"
)


def log(msg: str) -> None:
    print(f"[deploy-bots] {msg}")


def die(msg: str) -> None:
    print(f"[deploy-bots] FATAL: {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    """Ensure features, then for each bot: ensure resource -> deploy code ->
    bot fields (cron/audit trigger) -> project-admin flag -> reconcile the
    Subscription. Any HTTP failure aborts (die-fast) except the
    auditEventTrigger persistence check, which only warns."""
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

        # 4. Bot resource fields (cron bots have no Subscription; Medplum's
        # scheduler invokes them per Bot.cronString — requires the 'cron'
        # project feature). auditEventTrigger rides the same read-modify-
        # write; it is verified after the PUT because an older server that
        # doesn't know the field would silently strip it — that costs audit
        # noise, not correctness, so it warns instead of dying.
        desired_fields = {}
        if bot_def.get("cron"):
            desired_fields["cronString"] = bot_def["cron"]
        if bot_def.get("audit_event_trigger"):
            desired_fields["auditEventTrigger"] = bot_def["audit_event_trigger"]
        if desired_fields:
            bot_res = httpx.get(
                base + f"fhir/R4/Bot/{bot_id}", headers=headers, timeout=15
            ).json()
            if any(bot_res.get(k) != v for k, v in desired_fields.items()):
                bot_res.update(desired_fields)
                resp = httpx.put(
                    base + f"fhir/R4/Bot/{bot_id}",
                    json=bot_res,
                    headers=headers,
                    timeout=15,
                )
                if resp.status_code >= 400:
                    die(
                        f"bot field wiring failed: {resp.status_code} {resp.text[:300]}"
                    )
                log(f"set {desired_fields} on Bot/{bot_id}")
                if "auditEventTrigger" in desired_fields:
                    check = httpx.get(
                        base + f"fhir/R4/Bot/{bot_id}", headers=headers, timeout=15
                    ).json()
                    if (
                        check.get("auditEventTrigger")
                        != desired_fields["auditEventTrigger"]
                    ):
                        log(
                            "WARNING: auditEventTrigger did not persist (server too old?) — "
                            "cron runs will write an AuditEvent per tick"
                        )
            else:
                log(f"bot fields already set on Bot/{bot_id}: {desired_fields}")

        # 5. Project-admin flag. ProjectMembership is a project-admin resource
        # type, so bots that manage memberships (break-glass) silently 403
        # without admin=true on their own membership. Membership edits go
        # through the documented admin endpoint
        # (POST admin/projects/{id}/members/{membershipId}) — a plain FHIR PUT
        # is not the supported path for privilege changes.
        if bot_def.get("project_admin"):
            found_ms = httpx.get(
                base + "fhir/R4/ProjectMembership",
                params={"profile": f"Bot/{bot_id}", "_count": 1},
                headers=headers,
                timeout=15,
            )
            ms_entries = (
                found_ms.json().get("entry", []) if found_ms.status_code == 200 else []
            )
            if not ms_entries:
                die(f"no ProjectMembership found for Bot/{bot_id}")
            membership = ms_entries[0]["resource"]
            if membership.get("admin"):
                log(f"bot '{name}' membership already admin")
            else:
                membership["admin"] = True
                resp = httpx.post(
                    base + f"admin/projects/{project_id}/members/{membership['id']}",
                    json=membership,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json",
                    },
                    timeout=15,
                )
                if resp.status_code >= 400:
                    die(
                        f"promoting bot membership failed: {resp.status_code} {resp.text[:300]}"
                    )
                log(f"set admin=true on ProjectMembership/{membership['id']} ({name})")

        # 6. Reconcile the Subscription (event-triggered bots only). The
        # channel endpoint (Bot/{id}) is the stable key: the first active
        # Subscription pointing at this bot is updated in place when its
        # criteria/channel/extensions drifted from the table above, extras
        # are switched off — so a criteria edit here can never leave a stale
        # trigger firing alongside the new one.
        sub_def = bot_def["subscription"]
        if sub_def is None:
            continue
        endpoint = f"Bot/{bot_id}"
        desired_channel = {
            "type": "rest-hook",
            "endpoint": endpoint,
            "payload": "application/fhir+json",
        }
        desired_extensions = [
            {"url": SUPPORTED_INTERACTION_URL, "valueCode": interaction}
            for interaction in sub_def["supported_interactions"]
        ]
        subs = httpx.get(
            base + "fhir/R4/Subscription",
            params={"status": "active", "_count": 100},
            headers=headers,
            timeout=15,
        ).json()
        existing = [
            e["resource"]
            for e in subs.get("entry", [])
            if e["resource"].get("channel", {}).get("endpoint") == endpoint
        ]
        if not existing:
            resp = httpx.post(
                base + "fhir/R4/Subscription",
                json={
                    "resourceType": "Subscription",
                    "status": "active",
                    "reason": sub_def["reason"],
                    "criteria": sub_def["criteria"],
                    "channel": desired_channel,
                    "extension": desired_extensions,
                },
                headers=headers,
                timeout=15,
            )
            if resp.status_code >= 400:
                die(f"subscription create failed: {resp.status_code} {resp.text[:300]}")
            log(f"created Subscription/{resp.json()['id']}")
            continue
        current = existing[0]
        drifted = (
            current.get("criteria") != sub_def["criteria"]
            or current.get("channel") != desired_channel
            or current.get("extension") != desired_extensions
        )
        if drifted:
            current["criteria"] = sub_def["criteria"]
            current["channel"] = desired_channel
            current["extension"] = desired_extensions
            current["reason"] = sub_def["reason"]
            resp = httpx.put(
                base + f"fhir/R4/Subscription/{current['id']}",
                json=current,
                headers=headers,
                timeout=15,
            )
            if resp.status_code >= 400:
                die(f"subscription update failed: {resp.status_code} {resp.text[:300]}")
            log(f"updated Subscription/{current['id']} in place (definition drifted)")
        else:
            log(f"subscription exists: Subscription/{current['id']}")
        # Duplicates for the same bot endpoint keep firing with stale
        # criteria — switch them off (search was status=active only, so
        # already-off ones never resurface here).
        for extra in existing[1:]:
            extra["status"] = "off"
            resp = httpx.put(
                base + f"fhir/R4/Subscription/{extra['id']}",
                json=extra,
                headers=headers,
                timeout=15,
            )
            if resp.status_code >= 400:
                die(
                    f"subscription off-switch failed: {resp.status_code} {resp.text[:300]}"
                )
            log(f"switched off duplicate Subscription/{extra['id']}")

    log("done")


if __name__ == "__main__":
    main()
