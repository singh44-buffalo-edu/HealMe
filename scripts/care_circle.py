#!/usr/bin/env python
"""Care-circle membership management (Phase 9, FHIR-MAPPING.md §10).

Each member (caretaker / time-boxed clinician share) is a ProjectMembership
whose access[] binds a scoped, read-only AccessPolicy. Sharing has exactly one
mechanism: AccessPolicy — scope toggles map to resource[] rules pinned to the
patient via the %patient parameter (ProjectMembership.access.parameter).

Commands:
  add-caretaker        invite/update a RelatedPerson member with scoped read access
  add-clinician-share  invite/update a Practitioner member with an expiring share
  set-scopes           rewrite a member's AccessPolicy resource rules in place
  revoke               delete the member's ProjectMembership (policy kept for audit)
  list                 members + roles + scopes (+ expiry)
  expire-shares        revoke clinician shares past expiry (cron-able)

add-* / set-scopes are idempotent (re-runs update instead of duplicating) and
accept --dry-run, which prints the planned resources as JSON without touching
the network (usable with no .env and no running Medplum).

How the pieces fit:
  - %patient: policy criteria say e.g. `Observation?subject=%patient`; the
    VALUE comes from ProjectMembership.access[].parameter (name 'patient') —
    see access_binding(). Policy documents therefore contain no patient id.
  - Expiry is encoded twice: human-readable date in the policy NAME
    (`...|expires=YYYY-MM-DD`, parsed back by parse_bound_policy_name) and
    the exact instant in a Basic resource (code share-expiry, extension
    share-expiry valueDateTime) that `expire-shares` sweeps.
  - Locked areas in the caretaker UI are a presentation of server-side
    denial — the policy is the ONLY enforcement (FHIR-MAPPING.md §10).

Run with the venv python: `ai-service/.venv/bin/python scripts/care_circle.py
<command> ...`. Requires admin credentials in .env (from `make bootstrap`),
except --dry-run.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

BASE_URL = "https://healmedaily.local/fhir"
IDENT = BASE_URL + "/identifier"
CS_CARE = BASE_URL + "/CodeSystem/care-circle"
CS_OBS = BASE_URL + "/CodeSystem/observation"
EXT_SCOPES = BASE_URL + "/StructureDefinition/care-circle-scopes"
EXT_EXPIRY = BASE_URL + "/StructureDefinition/share-expiry"

ROLE_CARETAKER = "caretaker"
ROLE_CLINICIAN = "clinician-share"

# Scope -> read-only resource rules: the single source of truth for what a
# UI "scope toggle" grants. Criteria pin every patient-scoped type to the
# member's %patient parameter; Medication/Device have no patient reference
# by design (FHIR-MAPPING.md §5: Device.patient is never used for ownership),
# so they are plain read-only rules — acceptable exposure: med catalog +
# cartridge levels, no clinical events. Observation scopes slice one resource
# type by category (vitals/labs/survey) or code (symptom); a member with
# several scopes gets the union (deduped in build_policy). Anything not
# listed is denied — AccessPolicy is an allowlist.
SCOPE_RULES: dict[str, list[tuple[str, str | None]]] = {
    "meds": [
        ("Medication", None),
        ("MedicationRequest", "MedicationRequest?subject=%patient"),
        ("MedicationAdministration", "MedicationAdministration?subject=%patient"),
        ("Device", None),
    ],
    "vitals": [("Observation", "Observation?subject=%patient&category=vital-signs")],
    "labs": [
        ("Observation", "Observation?subject=%patient&category=laboratory"),
        ("DiagnosticReport", "DiagnosticReport?subject=%patient"),
    ],
    "checkins": [("Observation", "Observation?subject=%patient&category=survey")],
    "symptoms": [
        ("Observation", f"Observation?subject=%patient&code={CS_OBS}|symptom")
    ],
    "conditions": [("Condition", "Condition?subject=%patient")],
    "documents": [("DocumentReference", "DocumentReference?subject=%patient")],
    "alerts": [
        ("Communication", "Communication?subject=%patient"),
        ("CommunicationRequest", "CommunicationRequest?subject=%patient"),
    ],
}

DEFAULT_CARETAKER_SCOPES = "meds,vitals,checkins,alerts"
DEFAULT_CLINICIAN_SCOPES = "meds,vitals,labs,conditions,documents"


def log(msg: str) -> None:
    print(f"[care-circle] {msg}")


def die(msg: str) -> None:
    print(f"[care-circle] FATAL: {msg}", file=sys.stderr)
    sys.exit(1)


def read_env(key: str, default: str = "") -> str:
    """Minimal .env reader so --dry-run needs no third-party deps."""
    if os.environ.get(key):
        return os.environ[key].strip()
    env_path = REPO / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            stripped = line.strip()
            if stripped.startswith(f"{key}="):
                return stripped.split("=", 1)[1].strip()
    return default


# --- Planned-resource builders (shared by dry-run and live paths) -------------


def parse_scopes(raw: str) -> list[str]:
    """Validate a comma-separated scope list against SCOPE_RULES (die on typo
    — a silently dropped scope would under- or over-share)."""
    scopes = [s.strip() for s in raw.split(",") if s.strip()]
    if not scopes:
        die("no scopes given")
    for scope in scopes:
        if scope not in SCOPE_RULES:
            die(f"unknown scope '{scope}' — valid: {', '.join(sorted(SCOPE_RULES))}")
    return scopes


def policy_name(role: str, email: str, expires: str | None = None) -> str:
    """Policy name doubles as metadata: 'care-circle/{role}/{email}' plus an
    optional '|expires=YYYY-MM-DD' suffix for clinician shares. list/set-scopes
    parse it back via parse_bound_policy_name; ensure_policy matches on the
    role/email prefix so a renewed expiry updates rather than duplicates."""
    name = f"care-circle/{role}/{email}"
    if expires:
        name += f"|expires={expires}"
    return name


def build_policy(
    role: str, email: str, scopes: list[str], expires: str | None = None
) -> dict:
    """Assemble the member's read-only AccessPolicy: always a Patient rule
    pinned to %patient (so the member can render the owner's name), then the
    union of the chosen scopes' rules, deduped. The scopes string rides along
    in an extension purely so `list` can display it without reverse-mapping
    rules back to scope names."""
    resource: list[dict] = [
        {
            "resourceType": "Patient",
            "criteria": "Patient?_id=%patient",
            "readonly": True,
        }
    ]
    seen: set[tuple[str, str | None]] = set()
    for scope in scopes:
        for rtype, criteria in SCOPE_RULES[scope]:
            if (rtype, criteria) in seen:
                continue
            seen.add((rtype, criteria))
            rule: dict = {"resourceType": rtype, "readonly": True}
            if criteria:
                rule["criteria"] = criteria
            resource.append(rule)
    return {
        "resourceType": "AccessPolicy",
        "name": policy_name(role, email, expires),
        "resource": resource,
        "extension": [{"url": EXT_SCOPES, "valueString": ",".join(scopes)}],
    }


def access_binding(policy_ref: str, patient_ref: str) -> dict:
    """ProjectMembership.access entry: binds the policy AND supplies the value
    every %patient placeholder in that policy's criteria resolves to."""
    return {
        "policy": {"reference": policy_ref},
        "parameter": [
            {"name": "patient", "valueReference": {"reference": patient_ref}}
        ],
    }


def build_invite(
    profile_type: str,
    first: str,
    last: str,
    email: str,
    policy_ref: str,
    patient_ref: str,
) -> dict:
    """Body for Medplum's project-admin invite API, which creates the User,
    the profile resource (RelatedPerson for caretakers, Practitioner for
    clinicians — FHIR-MAPPING.md §10) and the ProjectMembership in one call.
    sendEmail=False because this private instance has no SMTP; the owner
    shares credentials out of band."""
    return {
        "resourceType": profile_type,
        "firstName": first,
        "lastName": last,
        "email": email,
        "sendEmail": False,
        "membership": {"access": [access_binding(policy_ref, patient_ref)]},
    }


def build_expiry_basic(email: str, expires_at: str, membership_ref: str) -> dict:
    """Machine-readable expiry record for a clinician share: a Basic (local
    code share-expiry) pointing at the membership, exact instant in the
    share-expiry extension. `expire-shares` scans these; the policy-name
    suffix is only the human-readable copy. Identifier is per-email, so
    re-inviting the same clinician replaces rather than stacks expiries."""
    return {
        "resourceType": "Basic",
        "code": {
            "coding": [
                {
                    "system": CS_CARE,
                    "code": "share-expiry",
                    "display": "Clinician share expiry",
                }
            ],
            "text": "Clinician share expiry",
        },
        "subject": {"reference": membership_ref},
        "created": expires_at[:10],
        "identifier": [{"system": f"{IDENT}/basic", "value": f"share-expiry-{email}"}],
        "extension": [{"url": EXT_EXPIRY, "valueDateTime": expires_at}],
    }


def placeholder_patient_ref() -> str:
    pid = read_env("MEDPLUM_PATIENT_ID")
    return f"Patient/{pid}" if pid else "Patient/<MEDPLUM_PATIENT_ID>"


# --- Live Medplum session ------------------------------------------------------


class Session:
    """Admin-password session (same flow as deploy_bots.py).

    Die-fast semantics: any 4xx/5xx aborts the whole script (except 404,
    which returns None so callers can branch on absence) — membership/policy
    edits must never half-apply silently.
    """

    def __init__(self) -> None:
        import httpx  # imported lazily so --dry-run has zero deps

        sys.path.insert(0, str(Path(__file__).parent))
        from bootstrap import env, password_login

        self._httpx = httpx
        base = env("MEDPLUM_BASE_URL", "http://localhost:8103/")
        self.base = base if base.endswith("/") else base + "/"
        self.project_id = env("MEDPLUM_PROJECT_ID")
        email, password = env("HMD_ADMIN_EMAIL"), env("HMD_ADMIN_PASSWORD")
        if not (self.project_id and email and password):
            die(
                "missing admin credentials/project in .env — run `make bootstrap` first"
            )
        token = password_login(self.base, email, password)
        if not token:
            die("admin login failed — check HMD_ADMIN_EMAIL/HMD_ADMIN_PASSWORD in .env")
        self.headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/fhir+json",
        }

    def request(self, method: str, path: str, **kwargs) -> dict | None:
        resp = self._httpx.request(
            method, self.base + path, headers=self.headers, timeout=20, **kwargs
        )
        if resp.status_code == 404:
            return None
        if resp.status_code >= 400:
            die(f"{method} {path} failed: {resp.status_code} {resp.text[:300]}")
        if resp.status_code == 204 or not resp.content:
            return {}
        return resp.json()

    def get(self, path: str, params: dict | None = None) -> dict | None:
        return self.request("GET", path, params=params)

    def post(self, path: str, body: dict) -> dict | None:
        return self.request("POST", path, json=body)

    def put(self, path: str, body: dict) -> dict | None:
        return self.request("PUT", path, json=body)

    def delete(self, path: str) -> None:
        self.request("DELETE", path)

    def patient_ref(self) -> str:
        """The single owner Patient (the %patient value): .env id when
        present, else lookup by the seeded business identifier."""
        pid = read_env("MEDPLUM_PATIENT_ID")
        if pid:
            return f"Patient/{pid}"
        identifier = read_env("HMD_PATIENT_IDENTIFIER", "healmedaily-user")
        bundle = self.get(
            "fhir/R4/Patient",
            {"identifier": f"{IDENT}/patient|{identifier}", "_count": "1"},
        )
        entries = (bundle or {}).get("entry", [])
        if not entries:
            die("no Patient found — run `make seed` or set MEDPLUM_PATIENT_ID in .env")
        return f"Patient/{entries[0]['resource']['id']}"


# --- Membership / policy plumbing ----------------------------------------------


def find_membership_by_email(sess: Session, email: str) -> dict | None:
    """Locate a member by email across the three places Medplum may keep it:
    user.display, the resolved User resource, or the profile's telecom.
    Fetching all memberships (_count=1000) is fine — a single-household
    project stays tiny; there is no email search parameter to lean on."""
    bundle = sess.get("fhir/R4/ProjectMembership", {"_count": "1000"}) or {}
    email_lc = email.lower()
    for entry in bundle.get("entry", []):
        membership = entry["resource"]
        user = membership.get("user") or {}
        if (user.get("display") or "").lower() == email_lc:
            return membership
        user_ref = user.get("reference", "")
        if user_ref.startswith("User/"):
            resolved = sess.get(f"fhir/R4/{user_ref}")
            if resolved and (resolved.get("email") or "").lower() == email_lc:
                return membership
        profile_ref = (membership.get("profile") or {}).get("reference", "")
        if profile_ref.split("/")[0] in ("RelatedPerson", "Practitioner"):
            profile = sess.get(f"fhir/R4/{profile_ref}")
            for telecom in (profile or {}).get("telecom", []):
                if (
                    telecom.get("system") == "email"
                    and (telecom.get("value") or "").lower() == email_lc
                ):
                    return membership
    return None


def ensure_policy(sess: Session, policy: dict, role: str, email: str) -> str:
    """Create or update-in-place the member's AccessPolicy; returns its id.

    Lookup is by the role/email name prefix so a clinician-share rename (new
    |expires= suffix) still updates the same policy instead of duplicating.
    """
    prefix = policy_name(role, email)
    bundle = sess.get("fhir/R4/AccessPolicy", {"name": prefix, "_count": "10"}) or {}
    existing = None
    for entry in bundle.get("entry", []):
        name = entry["resource"].get("name", "")
        if name == prefix or name.startswith(prefix + "|"):
            existing = entry["resource"]
            break
    if existing:
        updated = {**policy, "id": existing["id"]}
        sess.put(f"fhir/R4/AccessPolicy/{existing['id']}", updated)
        log(f"updated AccessPolicy/{existing['id']} ({policy['name']})")
        return existing["id"]
    created = sess.post("fhir/R4/AccessPolicy", policy) or {}
    log(f"created AccessPolicy/{created['id']} ({policy['name']})")
    return created["id"]


def upsert_expiry_basic(
    sess: Session, email: str, expires_at: str, membership_ref: str
) -> None:
    """Create or replace the member's share-expiry Basic (found by its
    per-email identifier) so renewals extend rather than stack."""
    basic = build_expiry_basic(email, expires_at, membership_ref)
    ident = basic["identifier"][0]
    bundle = (
        sess.get(
            "fhir/R4/Basic",
            {"identifier": f"{ident['system']}|{ident['value']}", "_count": "1"},
        )
        or {}
    )
    entries = bundle.get("entry", [])
    if entries:
        basic["id"] = entries[0]["resource"]["id"]
        sess.put(f"fhir/R4/Basic/{basic['id']}", basic)
        log(f"updated share-expiry Basic/{basic['id']} (expires {expires_at})")
    else:
        created = sess.post("fhir/R4/Basic", basic) or {}
        log(f"created share-expiry Basic/{created['id']} (expires {expires_at})")


def add_member(args: argparse.Namespace, role: str, profile_type: str) -> None:
    """add-caretaker / add-clinician-share implementation.

    Order matters: policy first (so the invite can bind it), then invite or
    rebind, then the expiry Basic. Idempotent throughout — an existing
    member's binding is rewritten in place; the policy is created-or-updated.
    Clinician shares compute expiry as now + --days (UTC). --dry-run prints
    the planned resources and never opens a network connection.
    """
    scopes = parse_scopes(args.scopes)
    expires_at: str | None = None
    if role == ROLE_CLINICIAN:
        expires_at = (datetime.now(timezone.utc) + timedelta(days=args.days)).isoformat(
            timespec="seconds"
        )
    policy = build_policy(
        role, args.email, scopes, expires_at[:10] if expires_at else None
    )

    if args.dry_run:
        plan = {
            "accessPolicy": policy,
            "invite": build_invite(
                profile_type,
                args.first,
                args.last,
                args.email,
                "AccessPolicy/<id-after-create>",
                placeholder_patient_ref(),
            ),
        }
        if expires_at:
            plan["shareExpiryBasic"] = build_expiry_basic(
                args.email, expires_at, "ProjectMembership/<id-after-invite>"
            )
        print(json.dumps(plan, indent=2))
        return

    sess = Session()
    patient_ref = sess.patient_ref()
    policy_id = ensure_policy(sess, policy, role, args.email)
    binding = access_binding(f"AccessPolicy/{policy_id}", patient_ref)

    membership = find_membership_by_email(sess, args.email)
    if membership:
        membership["access"] = [binding]
        sess.put(f"fhir/R4/ProjectMembership/{membership['id']}", membership)
        log(f"updated existing ProjectMembership/{membership['id']} for {args.email}")
    else:
        invite = build_invite(
            profile_type,
            args.first,
            args.last,
            args.email,
            f"AccessPolicy/{policy_id}",
            patient_ref,
        )
        result = sess.post(f"admin/projects/{sess.project_id}/invite", invite) or {}
        if result.get("resourceType") == "ProjectMembership":
            membership = result
        else:
            membership = find_membership_by_email(sess, args.email)
        if not membership:
            die("invite succeeded but the new ProjectMembership could not be found")
        log(
            f"invited {args.email} as {profile_type}: ProjectMembership/{membership['id']}"
        )

    if expires_at:
        upsert_expiry_basic(
            sess, args.email, expires_at, f"ProjectMembership/{membership['id']}"
        )
    log(f"done — {role} {args.email} scopes: {', '.join(scopes)}")


def parse_bound_policy_name(name: str) -> tuple[str, str | None]:
    """'care-circle/{role}/{email}[|expires=D]' -> (role, expires-date-or-None)."""
    body = name.removeprefix("care-circle/")
    expires = None
    if "|expires=" in body:
        body, expires = body.split("|expires=", 1)
    role = body.split("/", 1)[0]
    return role, expires


def cmd_set_scopes(args: argparse.Namespace) -> None:
    """Rewrite an existing member's policy rules in place, preserving role
    and expiry (both recovered from the bound policy's name). Refuses to
    touch non-care-circle members — the owner/admin binding is off limits."""
    scopes = parse_scopes(args.scopes)
    if args.dry_run:
        policy = build_policy("<current-role>", args.email, scopes)
        print(json.dumps({"accessPolicy": policy}, indent=2))
        return
    sess = Session()
    membership = find_membership_by_email(sess, args.email)
    if not membership:
        die(f"no project member with email {args.email}")
    access = membership.get("access") or []
    policy_ref = (access[0].get("policy") or {}).get("reference") if access else None
    if not policy_ref:
        die(
            f"{args.email} has no policy binding — use add-caretaker/add-clinician-share"
        )
    current = sess.get(f"fhir/R4/{policy_ref}")
    if not current:
        die(f"bound policy {policy_ref} not found")
    role, expires = parse_bound_policy_name(current.get("name", ""))
    if role not in (ROLE_CARETAKER, ROLE_CLINICIAN):
        die(f"{args.email} is not a care-circle member (policy: {current.get('name')})")
    updated = build_policy(role, args.email, scopes, expires)
    updated["id"] = current["id"]
    sess.put(f"fhir/R4/AccessPolicy/{current['id']}", updated)
    log(f"updated scopes for {args.email}: {', '.join(scopes)}")


def revoke_member(sess: Session, membership: dict, email: str) -> None:
    """Deleting the ProjectMembership ends access immediately (no membership,
    no project entry). The AccessPolicy is deliberately left behind as an
    audit artifact of what was shared; the expiry Basic is cleaned up."""
    sess.delete(f"fhir/R4/ProjectMembership/{membership['id']}")
    log(
        f"revoked ProjectMembership/{membership['id']} ({email}) — AccessPolicy kept for audit"
    )
    ident = f"{IDENT}/basic|share-expiry-{email}"
    bundle = sess.get("fhir/R4/Basic", {"identifier": ident, "_count": "1"}) or {}
    for entry in bundle.get("entry", []):
        sess.delete(f"fhir/R4/Basic/{entry['resource']['id']}")
        log(f"deleted share-expiry Basic/{entry['resource']['id']}")


def cmd_revoke(args: argparse.Namespace) -> None:
    sess = Session()
    membership = find_membership_by_email(sess, args.email)
    if not membership:
        die(f"no project member with email {args.email}")
    revoke_member(sess, membership, args.email)


def cmd_list(_args: argparse.Namespace) -> None:
    """Table of human members (bot/service memberships filtered out) with
    role, expiry and scopes — all reconstructed from the bound policy."""
    sess = Session()
    bundle = sess.get("fhir/R4/ProjectMembership", {"_count": "1000"}) or {}
    rows: list[tuple[str, str, str, str]] = []
    for entry in bundle.get("entry", []):
        membership = entry["resource"]
        profile_ref = (membership.get("profile") or {}).get("reference", "")
        profile_type = profile_ref.split("/")[0]
        if profile_type in ("ClientApplication", "Bot"):
            continue
        who = (membership.get("profile") or {}).get("display") or profile_ref
        email = (membership.get("user") or {}).get("display", "")
        access = membership.get("access") or []
        role, scopes, expires = "owner/admin", "-", ""
        if access:
            policy_ref = (access[0].get("policy") or {}).get("reference")
            policy = sess.get(f"fhir/R4/{policy_ref}") if policy_ref else None
            if policy and policy.get("name", "").startswith("care-circle/"):
                role, expiry_date = parse_bound_policy_name(policy["name"])
                expires = f" (expires {expiry_date})" if expiry_date else ""
                scopes = next(
                    (
                        e.get("valueString", "")
                        for e in policy.get("extension", [])
                        if e.get("url") == EXT_SCOPES
                    ),
                    "-",
                )
            elif policy:
                role = policy.get("name", "custom-policy")
        rows.append((who, email, role + expires, scopes))
    if not rows:
        log("no human members found")
        return
    widths = [max(len(row[i]) for row in rows) for i in range(4)]
    for row in rows:
        print("  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)).rstrip())


def cmd_expire_shares(_args: argparse.Namespace) -> None:
    """Cron-able sweep (see epilog): every share-expiry Basic past its instant
    revokes the membership and removes the Basic. Naive timestamps are read
    as UTC — the same convention add_member writes. Nothing auto-expires
    server-side; this sweep IS the enforcement of clinician-share expiry."""
    sess = Session()
    bundle = (
        sess.get("fhir/R4/Basic", {"code": f"{CS_CARE}|share-expiry", "_count": "100"})
        or {}
    )
    now = datetime.now(timezone.utc)
    expired = 0
    for entry in bundle.get("entry", []):
        basic = entry["resource"]
        raw = next(
            (
                e.get("valueDateTime")
                for e in basic.get("extension", [])
                if e.get("url") == EXT_EXPIRY
            ),
            None,
        )
        if not raw:
            continue
        expiry = datetime.fromisoformat(raw)
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        if expiry > now:
            log(f"share {basic['identifier'][0]['value']} still valid until {raw}")
            continue
        membership_ref = (basic.get("subject") or {}).get("reference", "")
        if membership_ref.startswith("ProjectMembership/"):
            if sess.get(f"fhir/R4/{membership_ref}") is not None:
                sess.delete(f"fhir/R4/{membership_ref}")
                log(f"revoked expired share: {membership_ref} (expired {raw})")
        sess.delete(f"fhir/R4/Basic/{basic['id']}")
        expired += 1
    log(f"expire-shares done — {expired} share(s) revoked")


def main() -> None:
    """CLI wiring — subcommands documented in the module docstring."""
    parser = argparse.ArgumentParser(
        prog="care_circle.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Cron suggestion for expiries: 0 * * * * cd <repo> && "
        "ai-service/.venv/bin/python scripts/care_circle.py expire-shares",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def member_args(p: argparse.ArgumentParser, default_scopes: str) -> None:
        p.add_argument("--email", required=True)
        p.add_argument("--first", required=True)
        p.add_argument("--last", required=True)
        p.add_argument(
            "--scopes",
            default=default_scopes,
            help=f"comma-separated: {', '.join(sorted(SCOPE_RULES))} (default: {default_scopes})",
        )
        p.add_argument(
            "--dry-run", action="store_true", help="print planned resources as JSON"
        )

    p_caretaker = sub.add_parser(
        "add-caretaker", help="invite/update a caretaker (RelatedPerson)"
    )
    member_args(p_caretaker, DEFAULT_CARETAKER_SCOPES)
    p_caretaker.set_defaults(
        func=lambda a: add_member(a, ROLE_CARETAKER, "RelatedPerson")
    )

    p_clin = sub.add_parser(
        "add-clinician-share",
        help="invite/update a time-boxed clinician share (Practitioner)",
    )
    member_args(p_clin, DEFAULT_CLINICIAN_SCOPES)
    p_clin.add_argument(
        "--days", type=int, required=True, help="share duration in days"
    )
    p_clin.set_defaults(func=lambda a: add_member(a, ROLE_CLINICIAN, "Practitioner"))

    p_scopes = sub.add_parser(
        "set-scopes", help="rewrite a member's policy rules in place"
    )
    p_scopes.add_argument("--email", required=True)
    p_scopes.add_argument("--scopes", required=True)
    p_scopes.add_argument("--dry-run", action="store_true")
    p_scopes.set_defaults(func=cmd_set_scopes)

    p_revoke = sub.add_parser("revoke", help="remove a member (policy kept for audit)")
    p_revoke.add_argument("--email", required=True)
    p_revoke.set_defaults(func=cmd_revoke)

    p_list = sub.add_parser("list", help="list members + roles + scopes")
    p_list.set_defaults(func=cmd_list)

    p_expire = sub.add_parser(
        "expire-shares", help="revoke clinician shares past expiry"
    )
    p_expire.set_defaults(func=cmd_expire_shares)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
