"""scripts/care_circle.py --dry-run: planned AccessPolicy/invite JSON shapes.

Runs the CLI as a subprocess (no live Medplum, no .env required) and asserts
the FHIR-MAPPING.md §10 invariants: read-only rules, %patient pinning,
role-named policies, expiry bookkeeping for clinician shares.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "care_circle.py"

CS_CARE = "https://healmedaily.local/fhir/CodeSystem/care-circle"
EXT_EXPIRY = "https://healmedaily.local/fhir/StructureDefinition/share-expiry"
EXT_SCOPES = "https://healmedaily.local/fhir/StructureDefinition/care-circle-scopes"


def run_dry(*args: str) -> dict:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), *args, "--dry-run"],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def test_caretaker_policy_shape() -> None:
    plan = run_dry(
        "add-caretaker",
        "--email",
        "sis@example.com",
        "--first",
        "Sis",
        "--last",
        "Ter",
        "--scopes",
        "meds,vitals",
    )
    policy = plan["accessPolicy"]
    assert policy["resourceType"] == "AccessPolicy"
    assert policy["name"] == "care-circle/caretaker/sis@example.com"

    rules = policy["resource"]
    # every rule is read-only — caretakers never write
    assert all(rule["readonly"] is True for rule in rules)

    by_type = {rule["resourceType"]: rule for rule in rules}
    # patient-scoped rules are pinned via the %patient parameter
    assert by_type["Patient"]["criteria"] == "Patient?_id=%patient"
    assert by_type["MedicationRequest"]["criteria"] == "MedicationRequest?subject=%patient"
    assert by_type["MedicationAdministration"]["criteria"] == ("MedicationAdministration?subject=%patient")
    assert by_type["Observation"]["criteria"] == "Observation?subject=%patient&category=vital-signs"
    # Medication/Device have no patient reference by design -> plain read rules
    assert "criteria" not in by_type["Medication"]
    assert "criteria" not in by_type["Device"]
    # nothing outside the requested scopes leaked in
    assert "Condition" not in by_type
    assert "DocumentReference" not in by_type

    scopes_ext = [e for e in policy["extension"] if e["url"] == EXT_SCOPES]
    assert scopes_ext and scopes_ext[0]["valueString"] == "meds,vitals"


def test_caretaker_invite_shape() -> None:
    plan = run_dry("add-caretaker", "--email", "sis@example.com", "--first", "Sis", "--last", "Ter")
    invite = plan["invite"]
    assert invite["resourceType"] == "RelatedPerson"
    assert invite["firstName"] == "Sis"
    assert invite["lastName"] == "Ter"
    assert invite["email"] == "sis@example.com"
    assert invite["sendEmail"] is False

    access = invite["membership"]["access"]
    assert len(access) == 1
    assert access[0]["policy"]["reference"].startswith("AccessPolicy/")
    parameter = access[0]["parameter"][0]
    assert parameter["name"] == "patient"
    assert parameter["valueReference"]["reference"].startswith("Patient/")


def test_clinician_share_policy_and_expiry() -> None:
    plan = run_dry(
        "add-clinician-share",
        "--email",
        "doc@example.com",
        "--first",
        "Doc",
        "--last",
        "Tor",
        "--days",
        "14",
        "--scopes",
        "labs,conditions",
    )
    policy = plan["accessPolicy"]
    match = re.fullmatch(
        r"care-circle/clinician-share/doc@example\.com\|expires=(\d{4}-\d{2}-\d{2})",
        policy["name"],
    )
    assert match, f"unexpected policy name: {policy['name']}"
    assert all(rule["readonly"] is True for rule in policy["resource"])
    by_type = {rule["resourceType"]: rule for rule in policy["resource"]}
    assert by_type["DiagnosticReport"]["criteria"] == "DiagnosticReport?subject=%patient"
    assert by_type["Condition"]["criteria"] == "Condition?subject=%patient"

    assert plan["invite"]["resourceType"] == "Practitioner"

    basic = plan["shareExpiryBasic"]
    assert basic["resourceType"] == "Basic"
    assert basic["code"]["coding"][0] == {
        "system": CS_CARE,
        "code": "share-expiry",
        "display": "Clinician share expiry",
    }
    assert basic["identifier"][0]["value"] == "share-expiry-doc@example.com"
    expiry_ext = [e for e in basic["extension"] if e["url"] == EXT_EXPIRY]
    assert expiry_ext
    expiry = datetime.fromisoformat(expiry_ext[0]["valueDateTime"])
    assert expiry.tzinfo is not None  # stored with an offset so the revoke job compares safely
    # the date suffix in the policy name matches the Basic's expiry date
    assert expiry_ext[0]["valueDateTime"][:10] == match.group(1)


def test_set_scopes_dry_run_rebuilds_rules() -> None:
    plan = run_dry("set-scopes", "--email", "sis@example.com", "--scopes", "documents,alerts")
    rules = plan["accessPolicy"]["resource"]
    assert all(rule["readonly"] is True for rule in rules)
    by_type = {rule["resourceType"]: rule for rule in rules}
    assert by_type["DocumentReference"]["criteria"] == "DocumentReference?subject=%patient"
    assert by_type["Communication"]["criteria"] == "Communication?subject=%patient"
    assert by_type["CommunicationRequest"]["criteria"] == "CommunicationRequest?subject=%patient"
    assert "MedicationRequest" not in by_type


def test_unknown_scope_fails() -> None:
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "add-caretaker",
            "--email",
            "x@example.com",
            "--first",
            "X",
            "--last",
            "Y",
            "--scopes",
            "everything",
            "--dry-run",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "unknown scope" in result.stderr
