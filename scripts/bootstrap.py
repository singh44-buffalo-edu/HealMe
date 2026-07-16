#!/usr/bin/env python
"""One-time bootstrap of the local self-hosted Medplum.

Run via `make bootstrap` after `make up` (waits for the server healthcheck —
first boot does one-time setup and can take minutes). Everything downstream
reads what this writes into the repo-root .env: seed.py, deploy_bots.py,
care_circle.py, smoke_test.py, and the ai-service's client-credentials login
(CLAUDE.md §5 "Auth"). Requires open self-registration, so keep
MEDPLUM_REGISTER_ENABLED commented out in infra/docker-compose.yml until this
has run once (hardening note there).

Creates (idempotently):
  1. The first user + the "HealMeDaily" Project (via the registration API)
  2. A ClientApplication for the Python service
  3. A least-privilege AccessPolicy ('service/healmedaily-ai') bound to the
     ClientApplication's ProjectMembership (Phase 9 hardening)
and persists ids/secrets into the repo-root .env.

⚠️ Least-privilege consequence: AccessPolicy is an allowlist. When the
ai-service gains a NEW resource type (or a write path to a currently
read-only one), add it to SERVICE_POLICY_RESOURCES below and re-run
`make bootstrap` — otherwise the service's first touch of that type is a 403.
Safe to re-run any time: the policy is updated in place.

Local-dev posture: the admin password is generated once and stored in .env
(gitignored) so re-runs and scripts can log in. Change it later in the
Medplum App if you want; then update .env to match.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
import string
import sys
import time
from pathlib import Path

import httpx
from dotenv import dotenv_values, set_key

REPO = Path(__file__).resolve().parents[1]
ENV_PATH = REPO / ".env"
PROJECT_NAME = "HealMeDaily"
CLIENT_NAME = "HealMeDaily Service"
DEFAULT_ADMIN_EMAIL = "owner@healmedaily.local"


def log(msg: str) -> None:
    print(f"[bootstrap] {msg}")


def die(msg: str) -> None:
    print(f"[bootstrap] FATAL: {msg}", file=sys.stderr)
    sys.exit(1)


def ensure_env_file() -> None:
    """Materialize .env from .env.example on first run (.env is gitignored —
    the only place secrets may live, CLAUDE.md §6)."""
    if not ENV_PATH.exists():
        example = REPO / ".env.example"
        ENV_PATH.write_text(example.read_text())
        log("created .env from .env.example")


def env(key: str, default: str = "") -> str:
    """Read a key from .env (re-parsed each call so mid-run saves are seen)."""
    return (dotenv_values(ENV_PATH).get(key) or default).strip()


def save(key: str, value: str) -> None:
    """Persist a key into .env (unquoted — values are ids/secrets, never shell)."""
    set_key(ENV_PATH, key, value, quote_mode="never")


def wait_for_server(base: str) -> None:
    """Block until the Medplum healthcheck passes; give up after ~5 minutes.

    First boot runs migrations/seeding before the healthcheck goes green
    (CLAUDE.md §5: "wait minutes, don't panic").
    """
    log(f"waiting for {base}healthcheck ...")
    for _ in range(150):
        try:
            if httpx.get(base + "healthcheck", timeout=3).status_code == 200:
                log("server healthy")
                return
        except httpx.HTTPError:
            pass
        time.sleep(2)
    die("Medplum server never became healthy — run `make up` first")


def make_pkce() -> tuple[str, str]:
    """Returns (code_verifier, S256 code_challenge) — Medplum requires PKCE on code exchange."""
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b"=").decode()
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return verifier, challenge


def exchange_code(base: str, code: str, verifier: str) -> str:
    """Second half of PKCE: trade the auth code + verifier for an access token.

    Forgetting the verifier is the classic "Missing verification context"
    error (CLAUDE.md §9).
    """
    resp = httpx.post(
        base + "oauth2/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
        },
        timeout=10,
    )
    if resp.status_code != 200:
        die(f"auth code exchange failed: {resp.status_code} {resp.text[:300]}")
    return resp.json()["access_token"]


def password_login(base: str, email: str, password: str) -> str | None:
    """Email/password login via the auth API (PKCE required).

    Returns an access token, or None if login failed — callers treat None as
    "user does not exist yet" (register) or "wrong .env credentials" (die).
    Also imported by seed.py / deploy_bots.py / care_circle.py as THE shared
    admin-login helper.
    """
    verifier, challenge = make_pkce()
    resp = httpx.post(
        base + "auth/login",
        json={
            "email": email,
            "password": password,
            "scope": "openid",
            "codeChallenge": challenge,
            "codeChallengeMethod": "S256",
        },
        timeout=10,
    )
    if resp.status_code != 200:
        return None
    data = resp.json()
    if data.get("code"):
        return exchange_code(base, data["code"], verifier)
    # More than one membership: pick the first explicitly.
    login_id = data.get("login")
    memberships = data.get("memberships") or []
    if login_id and memberships:
        resp2 = httpx.post(
            base + "auth/profile",
            json={"login": login_id, "profile": memberships[0]["id"]},
            timeout=10,
        )
        if resp2.status_code == 200 and resp2.json().get("code"):
            return exchange_code(base, resp2.json()["code"], verifier)
    return None


def register_first_user(
    base: str, email: str, password: str, given: str, family: str
) -> str:
    """Register the owner account + the HealMeDaily Project via the open
    registration API, then return an admin token for that project.

    Only works while registerEnabled is on (empty recaptchaToken is fine
    because the compose file blanks the recaptcha keys). This user becomes
    the project admin — the account you sign into :3000 and :5173 with.
    """
    verifier, challenge = make_pkce()
    resp = httpx.post(
        base + "auth/newuser",
        json={
            "firstName": given,
            "lastName": family,
            "email": email,
            "password": password,
            "recaptchaToken": "",
            "codeChallenge": challenge,
            "codeChallengeMethod": "S256",
        },
        timeout=15,
    )
    if resp.status_code != 200:
        die(f"newuser failed: {resp.status_code} {resp.text[:300]}")
    login_id = resp.json()["login"]
    resp2 = httpx.post(
        base + "auth/newproject",
        json={"login": login_id, "projectName": PROJECT_NAME},
        timeout=15,
    )
    if resp2.status_code != 200:
        die(f"newproject failed: {resp2.status_code} {resp2.text[:300]}")
    return exchange_code(base, resp2.json()["code"], verifier)


def fhir_get(base: str, token: str, path: str, params: dict | None = None) -> dict:
    """GET fhir/R4/<path>; any 4xx/5xx aborts the bootstrap (fail loudly)."""
    resp = httpx.get(
        base + "fhir/R4/" + path,
        params=params,
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    if resp.status_code >= 400:
        die(f"GET {path} failed: {resp.status_code} {resp.text[:300]}")
    return resp.json()


def find_project_id(base: str, token: str) -> str:
    """Resolve the Project id by name, else 'the only project I can see'.

    The fallback covers a renamed project on this single-project instance;
    with several visible projects and no name match we cannot guess — die.
    """
    bundle = fhir_get(base, token, "Project", {"name": PROJECT_NAME, "_count": 5})
    for entry in bundle.get("entry", []):
        if entry["resource"].get("name") == PROJECT_NAME:
            return entry["resource"]["id"]
    # Fall back to the only visible project
    bundle = fhir_get(base, token, "Project", {"_count": 2})
    entries = bundle.get("entry", [])
    if len(entries) == 1:
        return entries[0]["resource"]["id"]
    die(f"could not identify the {PROJECT_NAME} project")
    raise AssertionError  # unreachable


def ensure_client_app(base: str, token: str, project_id: str) -> tuple[str, str]:
    """Find-or-create the service ClientApplication; returns (id, secret).

    Created through the project-admin API (which also mints its
    ProjectMembership). The secret lands in .env for the ai-service's
    client-credentials grant — it is never stored anywhere else.
    """
    bundle = fhir_get(
        base, token, "ClientApplication", {"name": CLIENT_NAME, "_count": 5}
    )
    for entry in bundle.get("entry", []):
        res = entry["resource"]
        if res.get("name") == CLIENT_NAME and res.get("secret"):
            log(f"reusing ClientApplication/{res['id']}")
            return res["id"], res["secret"]
    resp = httpx.post(
        base + f"admin/projects/{project_id}/client",
        json={
            "name": CLIENT_NAME,
            "description": "Python AI/ingestion service (client credentials)",
        },
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    if resp.status_code >= 400:
        die(f"client creation failed: {resp.status_code} {resp.text[:300]}")
    client = resp.json()
    log(f"created ClientApplication/{client['id']}")
    return client["id"], client["secret"]


SERVICE_POLICY_NAME = "service/healmedaily-ai"

# Least privilege for the Python ai-service (Phase 9 hardening). AccessPolicy
# is an allowlist by nature: any resource type not listed is denied. Read-only
# types cover lookups the service needs but must never alter (the regimen, the
# question bank, raw check-in answers, the Patient). AuditEvent is create-only
# (boundary-ledger writes — a ledger entry must never be updatable). Everything
# read/write is what ingestion, Health Review and reminders actually touch
# today (see ai-service/app).
#
# ⚠️ Maintenance rule: a new ai-service write path needs its resource type
# added here + `make bootstrap` re-run, or the service gets 403s. Symptom in
# the wild: httpx.HTTPStatusError 403 on a single resource type while
# everything else works.
SERVICE_POLICY_RESOURCES: list[dict] = [
    {"resourceType": "Patient", "readonly": True},
    {"resourceType": "Medication", "readonly": True},
    {"resourceType": "MedicationRequest", "readonly": True},
    {"resourceType": "Questionnaire", "readonly": True},
    # writable: service-side check-in replays exercise the QR→Observation bot
    # through these credentials (smoke test does exactly this)
    {"resourceType": "QuestionnaireResponse"},
    {"resourceType": "Observation"},
    {"resourceType": "MedicationAdministration"},
    {"resourceType": "MedicationStatement"},
    {"resourceType": "Device"},
    {"resourceType": "DocumentReference"},
    {"resourceType": "Binary"},
    {"resourceType": "Task"},
    {"resourceType": "Provenance"},
    {"resourceType": "DiagnosticReport"},
    {"resourceType": "Condition"},
    {"resourceType": "AllergyIntolerance"},
    {"resourceType": "Immunization"},
    {"resourceType": "Communication"},
    {"resourceType": "CommunicationRequest"},
    {"resourceType": "SupplyDelivery"},
    {"resourceType": "Basic"},
    {"resourceType": "AuditEvent", "interaction": ["create"]},
]


def ensure_service_access_policy(base: str, token: str, client_id: str) -> None:
    """Create/update the ai-service AccessPolicy and bind it to the
    ClientApplication's ProjectMembership.access. Idempotent.

    The update-in-place PUT is what makes re-running bootstrap the official
    way to roll out SERVICE_POLICY_RESOURCES changes. Binding goes on the
    membership (not the client) because that is where Medplum evaluates
    access[] (CLAUDE.md §5 "Auth"). An unbound membership would mean
    project-admin-level access for the service — never leave it that way.
    """
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/fhir+json",
    }
    policy = {
        "resourceType": "AccessPolicy",
        "name": SERVICE_POLICY_NAME,
        "resource": SERVICE_POLICY_RESOURCES,
    }
    bundle = fhir_get(
        base, token, "AccessPolicy", {"name": SERVICE_POLICY_NAME, "_count": 5}
    )
    policy_id = None
    for entry in bundle.get("entry", []):
        if entry["resource"].get("name") == SERVICE_POLICY_NAME:
            policy_id = entry["resource"]["id"]
            break
    if policy_id:
        resp = httpx.put(
            base + f"fhir/R4/AccessPolicy/{policy_id}",
            json={**policy, "id": policy_id},
            headers=headers,
            timeout=15,
        )
        if resp.status_code >= 400:
            die(f"AccessPolicy update failed: {resp.status_code} {resp.text[:300]}")
        log(f"updated AccessPolicy/{policy_id} ({SERVICE_POLICY_NAME})")
    else:
        resp = httpx.post(
            base + "fhir/R4/AccessPolicy", json=policy, headers=headers, timeout=15
        )
        if resp.status_code >= 400:
            die(f"AccessPolicy create failed: {resp.status_code} {resp.text[:300]}")
        policy_id = resp.json()["id"]
        log(f"created AccessPolicy/{policy_id} ({SERVICE_POLICY_NAME})")

    memberships = fhir_get(
        base,
        token,
        "ProjectMembership",
        {"profile": f"ClientApplication/{client_id}", "_count": 5},
    )
    entries = memberships.get("entry", [])
    if not entries:
        die(f"no ProjectMembership found for ClientApplication/{client_id}")
    membership = entries[0]["resource"]
    desired = [{"policy": {"reference": f"AccessPolicy/{policy_id}"}}]
    if membership.get("access") == desired:
        log("service ClientApplication already bound to the least-privilege policy")
        return
    membership["access"] = desired
    resp = httpx.put(
        base + f"fhir/R4/ProjectMembership/{membership['id']}",
        json=membership,
        headers=headers,
        timeout=15,
    )
    if resp.status_code >= 400:
        die(f"membership access binding failed: {resp.status_code} {resp.text[:300]}")
    log(f"bound {SERVICE_POLICY_NAME} to ProjectMembership/{membership['id']}")


def verify_client_credentials(base: str, client_id: str, client_secret: str) -> None:
    """Prove the freshly written credentials work end-to-end: token grant +
    a policy-scoped FHIR read. Fails here, loudly, rather than at the
    ai-service's first real call."""
    resp = httpx.post(
        base + "oauth2/token",
        data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
        },
        timeout=10,
    )
    if resp.status_code != 200:
        die(
            f"client-credentials verification failed: {resp.status_code} {resp.text[:300]}"
        )
    token = resp.json()["access_token"]
    fhir_get(base, token, "Patient", {"_count": 1})
    log("client-credentials auth verified with a FHIR read")


def main() -> None:
    """Full bootstrap sequence; every step is idempotent, so re-run freely."""
    ensure_env_file()
    base = env("MEDPLUM_BASE_URL", "http://localhost:8103/")
    if not base.endswith("/"):
        base += "/"
    wait_for_server(base)

    email = env("HMD_ADMIN_EMAIL") or DEFAULT_ADMIN_EMAIL
    password = env("HMD_ADMIN_PASSWORD")
    if not password:
        alphabet = string.ascii_letters + string.digits
        password = "".join(secrets.choice(alphabet) for _ in range(24))
        # Persist BEFORE registration so a failed run never strands an
        # account whose password we no longer know.
        save("HMD_ADMIN_EMAIL", email)
        save("HMD_ADMIN_PASSWORD", password)
        log("admin password generated and stored in .env (local dev only)")

    token = password_login(base, email, password)
    if token:
        log(f"logged in as existing user {email}")
    else:
        log(f"registering first user {email} + project '{PROJECT_NAME}'")
        token = register_first_user(
            base, email, password, given="HealMeDaily", family="Owner"
        )
    save("HMD_ADMIN_EMAIL", email)
    save("HMD_ADMIN_PASSWORD", password)

    project_id = find_project_id(base, token)
    save("MEDPLUM_PROJECT_ID", project_id)
    log(f"project: {project_id}")

    client_id, client_secret = ensure_client_app(base, token, project_id)
    save("MEDPLUM_CLIENT_ID", client_id)
    save("MEDPLUM_CLIENT_SECRET", client_secret)

    ensure_service_access_policy(base, token, client_id)

    verify_client_credentials(base, client_id, client_secret)

    log("done. Sign in at http://localhost:3000 and the frontend with:")
    log(f"  email:    {email}")
    log("  password: (see HMD_ADMIN_PASSWORD in .env)")


if __name__ == "__main__":
    main()
