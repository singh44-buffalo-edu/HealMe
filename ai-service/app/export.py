"""Full-record export: FHIR R4 collection bundle and observations CSV.
The user owns everything and can take it with them (spec IR-1/IR-3/PR-4).

Served by main.py (/export/*). Both formats round-trip through importers.py
(the CSV column layout is the contract prepare_csv_entries validates; the
bundle re-imports via /import/fhir with dedup, so export→import is lossless
for record data). Read-only over the CDR — this module never writes.

NOTE: API keys / AI settings are NOT part of the record and never appear in
exports (keystore.py rationale, FHIR-MAPPING §11)."""

from __future__ import annotations

import csv
import io
from datetime import datetime, timezone
from typing import Any

from .medplum import MedplumFhirClient

# Every resource type this app writes (FHIR-MAPPING §2 domain map) — extend
# when a new phase introduces a type, or exports silently go incomplete
# (Communication/CommunicationRequest/MedicationDispense drifted out exactly
# that way once; tests/test_export.py now guards the known-writer list).
#
# Deliberately absent:
# - Binary: raw bytes would balloon a JSON bundle (base64) and Attachment.data
#   embedding is banned (FHIR-MAPPING §6). The exported DocumentReferences
#   keep their Binary/{id} references; the bytes themselves are covered by the
#   physical backup (scripts/backup.py / `make backup` tars the server's
#   binary store alongside pg_dump).
# - AuditEvent: server telemetry (logins, bot runs) mixed with our ledger —
#   an audit trail, not record data; pg_dump preserves it.
EXPORT_TYPES = [
    "Patient",
    "Medication",
    "MedicationRequest",
    "MedicationAdministration",
    "MedicationDispense",
    "MedicationStatement",
    "Observation",
    "Condition",
    "AllergyIntolerance",
    "Immunization",
    "Procedure",
    "DiagnosticReport",
    "DocumentReference",
    "Questionnaire",
    "QuestionnaireResponse",
    "Device",
    "SupplyDelivery",
    "Provenance",
    "Task",
    "Communication",  # assistant Q&A sessions (assistant.py)
    "CommunicationRequest",  # reminders / dispenser escalations (bots, pi-dispenser)
    "Basic",  # owner alert-rule prefs + share-expiry markers (FHIR-MAPPING §10)
]

# Safety ceiling per type: 100 pages × _count=1000. Next-link pagination has
# no server-side depth cap (unlike _offset's 10 000), so this only bounds a
# runaway export; hitting it is surfaced as a truncation tag, never silence.
MAX_PAGES_PER_TYPE = 100
TAGS = "https://healmedaily.local/fhir/tags"


def _all_resources(medplum: MedplumFhirClient, resource_type: str) -> tuple[list[dict[str, Any]], bool]:
    """Every resource of a type via Bundle.link.next cursor pagination
    (medplum.search_all) — Medplum's recommended way through large datasets;
    the previous _offset loop broke past the server's 10 000-offset cap and
    could skip/repeat rows when writes interleaved. Returns (resources,
    truncated); truncated only past MAX_PAGES_PER_TYPE."""
    return medplum.search_all(resource_type, {"_count": 1000, "_sort": "_lastUpdated"}, max_pages=MAX_PAGES_PER_TYPE)


def export_fhir_bundle(medplum: MedplumFhirClient) -> dict[str, Any]:
    """Whole record as one `collection` Bundle (not `transaction` — it is a
    snapshot document, not a replay script; importers rebuild write semantics).
    Resources keep their ids/meta so provenance survives the round trip.
    A type that exceeds MAX_PAGES_PER_TYPE is exported partially and marked
    with a `truncated-{Type}` meta tag — a partial export must never present
    itself as complete."""
    entries = []
    counts: dict[str, int] = {}
    tags = [{"system": TAGS, "code": "full-export"}]
    for resource_type in EXPORT_TYPES:
        resources, truncated = _all_resources(medplum, resource_type)
        counts[resource_type] = len(resources)
        if truncated:
            tags.append({"system": TAGS, "code": f"truncated-{resource_type}"})
        entries.extend({"resource": r} for r in resources)
    return {
        "resourceType": "Bundle",
        "type": "collection",
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "total": len(entries),
        "meta": {"tag": tags},
        "entry": entries,
    }


def export_observations_csv(medplum: MedplumFhirClient) -> str:
    """All Observations flattened to CSV. The header row is a contract:
    importers.prepare_csv_entries requires effective/code/display/value —
    change columns in both places together or round-tripping breaks. (That
    contract also means no in-band truncation marker here: past the
    MAX_PAGES_PER_TYPE ceiling the CSV is simply cut short — the FHIR bundle,
    which does tag truncation, is the completeness-guaranteed takeout.)"""
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["id", "effective", "code_system", "code", "display", "value", "unit", "status", "category"])
    observations, _truncated = _all_resources(medplum, "Observation")
    for obs in observations:
        coding = (obs.get("code", {}).get("coding") or [{}])[0]
        vq = obs.get("valueQuantity", {})
        value = (
            vq.get("value")
            if vq
            else obs.get("valueInteger")
            if obs.get("valueInteger") is not None
            else obs.get("valueString", "")
        )
        writer.writerow(
            [
                obs.get("id", ""),
                obs.get("effectiveDateTime") or obs.get("effectivePeriod", {}).get("end", ""),
                coding.get("system", ""),
                coding.get("code", ""),
                obs.get("code", {}).get("text") or coding.get("display", ""),
                value,
                vq.get("unit", ""),
                obs.get("status", ""),
                (obs.get("category", [{}])[0].get("coding") or [{}])[0].get("code", ""),
            ]
        )
    return buffer.getvalue()
