"""Full-record export: FHIR R4 collection bundle and observations CSV.
The user owns everything and can take it with them (spec IR-1/IR-3/PR-4)."""

from __future__ import annotations

import csv
import io
from datetime import datetime, timezone
from typing import Any

from .medplum import MedplumFhirClient

EXPORT_TYPES = [
    "Patient",
    "Medication",
    "MedicationRequest",
    "MedicationAdministration",
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
]

MAX_PAGES_PER_TYPE = 20  # 20 x 1000 — far beyond current single-user volumes


def _all_resources(medplum: MedplumFhirClient, resource_type: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    offset = 0
    for _ in range(MAX_PAGES_PER_TYPE):
        bundle = medplum.search(resource_type, {"_count": 1000, "_offset": offset, "_sort": "_lastUpdated"})
        entries = bundle.get("entry", [])
        out.extend(e["resource"] for e in entries)
        if len(entries) < 1000:
            break
        offset += 1000
    return out


def export_fhir_bundle(medplum: MedplumFhirClient) -> dict[str, Any]:
    entries = []
    counts: dict[str, int] = {}
    for resource_type in EXPORT_TYPES:
        resources = _all_resources(medplum, resource_type)
        counts[resource_type] = len(resources)
        entries.extend({"resource": r} for r in resources)
    return {
        "resourceType": "Bundle",
        "type": "collection",
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "total": len(entries),
        "meta": {"tag": [{"system": "https://healmedaily.local/fhir/tags", "code": "full-export"}]},
        "entry": entries,
    }


def export_observations_csv(medplum: MedplumFhirClient) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        ["id", "effective", "code_system", "code", "display", "value", "unit", "status", "category"]
    )
    for obs in _all_resources(medplum, "Observation"):
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
