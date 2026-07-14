"""Structured importers: FHIR R4 bundles, observations CSV (our own export
format round-trips), and Apple Health export XML.

Design: pure `prepare_*` functions turn source data into transaction-bundle
entries (unit-testable, no I/O); `commit_entries` posts them in chunks. Every
imported resource carries a deterministic import identifier so re-importing
the same file is a no-op (dedup), an `imported` meta tag, and a Provenance
records the batch. These importers are deterministic transforms of records
that already exist elsewhere — no AI is involved, so they commit directly
rather than through the AI-extraction review queue.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any
from xml.etree import ElementTree

from . import fhir_consts as fc
from .medplum import MedplumFhirClient

IMPORT_IDENT = f"{fc.IDENT}/import"
IMPORT_TAG = {"system": f"{fc.BASE}/tags", "code": "imported", "display": "Imported record"}

ALLOWED_IMPORT_TYPES = {
    "Observation",
    "Condition",
    "AllergyIntolerance",
    "Immunization",
    "Procedure",
    "DiagnosticReport",
    "MedicationStatement",
    "Encounter",
    "Practitioner",
    "Organization",
}

PATIENT_REF_FIELDS = {"subject", "patient"}
CHUNK = 100


def _hash_ident(payload: str) -> dict[str, str]:
    return {"system": IMPORT_IDENT, "value": hashlib.sha256(payload.encode()).hexdigest()[:32]}


def _entry(resource: dict[str, Any], ident: dict[str, str], full_url: str | None = None) -> dict[str, Any]:
    resource.setdefault("identifier", [])
    if isinstance(resource["identifier"], list):  # Encounter etc. all use lists here
        if not any(i.get("system") == IMPORT_IDENT for i in resource["identifier"]):
            resource["identifier"].append(ident)
    resource.setdefault("meta", {}).setdefault("tag", []).append(IMPORT_TAG)
    entry: dict[str, Any] = {
        "resource": resource,
        "request": {
            "method": "POST",
            "url": resource["resourceType"],
            "ifNoneExist": f"identifier={ident['system']}|{ident['value']}",
        },
    }
    if full_url:
        entry["fullUrl"] = full_url
    return entry


# --- FHIR bundle ---------------------------------------------------------------


def _scrub_refs(node: Any, local_ids: set[str], patient_ref: str) -> Any:
    """Retarget patient references; keep intra-bundle references; drop
    references that point at resources we are not importing."""
    if isinstance(node, dict):
        out = {}
        for key, value in node.items():
            if key in PATIENT_REF_FIELDS and isinstance(value, dict) and "reference" in value:
                out[key] = {"reference": patient_ref}
            elif isinstance(value, dict) and set(value) & {"reference"} and isinstance(value.get("reference"), str):
                ref = value["reference"]
                if ref in local_ids or ref.startswith("#"):
                    out[key] = value
                # else: dangling external reference — drop the field
            else:
                scrubbed = _scrub_refs(value, local_ids, patient_ref)
                if scrubbed is not None:
                    out[key] = scrubbed
        return out
    if isinstance(node, list):
        items = [_scrub_refs(v, local_ids, patient_ref) for v in node]
        return [v for v in items if v is not None]
    return node


def prepare_fhir_entries(bundle: dict[str, Any], patient_id: str) -> tuple[list[dict], dict[str, int]]:
    if bundle.get("resourceType") != "Bundle":
        raise ValueError("file is not a FHIR Bundle")
    patient_ref = f"Patient/{patient_id}"
    raw_entries = bundle.get("entry", [])

    # Map every local id/fullUrl so intra-bundle references survive
    local_ids: set[str] = set()
    for e in raw_entries:
        res = e.get("resource") or {}
        if e.get("fullUrl"):
            local_ids.add(e["fullUrl"])
        if res.get("resourceType") and res.get("id"):
            local_ids.add(f"{res['resourceType']}/{res['id']}")

    entries: list[dict] = []
    skipped: dict[str, int] = defaultdict(int)
    for e in raw_entries:
        res = e.get("resource")
        if not res or not isinstance(res, dict):
            continue
        rtype = res.get("resourceType", "")
        if rtype not in ALLOWED_IMPORT_TYPES:
            skipped[rtype or "unknown"] += 1
            continue
        original_ref = f"{rtype}/{res['id']}" if res.get("id") else e.get("fullUrl")
        cleaned = {k: v for k, v in res.items() if k not in ("id", "meta")}
        cleaned = _scrub_refs(cleaned, local_ids, patient_ref)
        ident = _hash_ident(json.dumps({k: v for k, v in cleaned.items() if k != "identifier"}, sort_keys=True))
        # fullUrl keeps intra-bundle references (DiagnosticReport.result etc.) resolvable
        entries.append(_entry(cleaned, ident, full_url=e.get("fullUrl") or original_ref))
    return entries, dict(skipped)


# --- Observations CSV (our export format) ---------------------------------------


def prepare_csv_entries(text: str, patient_id: str) -> tuple[list[dict], dict[str, int]]:
    reader = csv.DictReader(io.StringIO(text))
    required = {"effective", "code", "display", "value"}
    if not reader.fieldnames or not required.issubset(set(reader.fieldnames)):
        raise ValueError(f"CSV must have headers including {sorted(required)} (the app's own export format)")
    entries: list[dict] = []
    skipped: dict[str, int] = defaultdict(int)
    for row in reader:
        value_raw = (row.get("value") or "").strip()
        effective = (row.get("effective") or "").strip()
        code = (row.get("code") or "").strip()
        if not value_raw or not effective or not code:
            skipped["missing-fields"] += 1
            continue
        system = (row.get("code_system") or "").strip() or fc.CS_OBS
        display = (row.get("display") or "").strip()
        category = (row.get("category") or "").strip()
        coding: dict[str, Any] = {"system": system, "code": code}
        if display:
            coding["display"] = display
        obs: dict[str, Any] = {
            "resourceType": "Observation",
            "status": "final",
            "subject": {"reference": f"Patient/{patient_id}"},
            "code": {"coding": [coding], "text": display or code},
            "effectiveDateTime": effective,
        }
        if category:
            obs["category"] = [
                {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/observation-category", "code": category}]}
            ]
        try:
            quantity: dict[str, Any] = {"value": float(value_raw)}
            unit = (row.get("unit") or "").strip()
            if unit:
                quantity["unit"] = unit
            obs["valueQuantity"] = quantity
        except ValueError:
            obs["valueString"] = value_raw
        ident = _hash_ident(f"csv|{code}|{effective}|{value_raw}")
        entries.append(_entry(obs, ident))
    return entries, dict(skipped)


# --- Apple Health export.xml ------------------------------------------------------


APPLE_QUANTITY_MAP = {
    # HK type -> (loinc code, display, target unit, category)
    "HKQuantityTypeIdentifierBodyMass": ("29463-7", "Body weight", "kg", "vital-signs"),
    "HKQuantityTypeIdentifierHeartRate": ("8867-4", "Heart rate", "/min", "vital-signs"),
    "HKQuantityTypeIdentifierOxygenSaturation": ("59408-5", "Oxygen saturation", "%", "vital-signs"),
}


def prepare_apple_entries(xml_bytes: bytes, patient_id: str) -> tuple[list[dict], dict[str, int]]:
    """Stream-parse Apple Health export.xml. Point-in-time vitals import
    directly; steps and sleep are aggregated per local date."""
    patient_ref = f"Patient/{patient_id}"
    entries: list[dict] = []
    skipped: dict[str, int] = defaultdict(int)
    steps_by_date: dict[str, float] = defaultdict(float)
    sleep_by_date: dict[str, float] = defaultdict(float)

    def quantity_obs(code: str, display: str, unit: str, category: str, when: str, value: float, ident_key: str):
        return _entry(
            {
                "resourceType": "Observation",
                "status": "final",
                "subject": {"reference": patient_ref},
                "category": [
                    {
                        "coding": [
                            {"system": "http://terminology.hl7.org/CodeSystem/observation-category", "code": category}
                        ]
                    }
                ],
                "code": {"coding": [{"system": fc.LOINC, "code": code, "display": display}], "text": display},
                "effectiveDateTime": when,
                "valueQuantity": {"value": value, "unit": unit},
            },
            _hash_ident(ident_key),
        )

    for _, elem in ElementTree.iterparse(io.BytesIO(xml_bytes), events=("end",)):
        if elem.tag != "Record":
            continue
        rtype = elem.get("type", "")
        start = elem.get("startDate", "")
        value = elem.get("value", "")
        if rtype in APPLE_QUANTITY_MAP and start and value:
            code, display, target_unit, category = APPLE_QUANTITY_MAP[rtype]
            try:
                v = float(value)
            except ValueError:
                skipped["bad-value"] += 1
                elem.clear()
                continue
            unit = elem.get("unit", "")
            if rtype == "HKQuantityTypeIdentifierBodyMass" and unit == "lb":
                v = round(v * 0.45359237, 1)
            if rtype == "HKQuantityTypeIdentifierOxygenSaturation" and v <= 1:
                v = round(v * 100, 1)
            when = _apple_datetime(start)
            entries.append(
                quantity_obs(code, display, target_unit, category, when, v, f"apple|{rtype}|{start}|{value}")
            )
        elif rtype == "HKQuantityTypeIdentifierStepCount" and start and value:
            try:
                steps_by_date[start[:10]] += float(value)
            except ValueError:
                skipped["bad-value"] += 1
        elif rtype == "HKCategoryTypeIdentifierSleepAnalysis" and start:
            # Sum any "asleep" interval into the night ending at endDate's date
            v = elem.get("value", "")
            end = elem.get("endDate", "")
            if "Asleep" in v and end:
                try:
                    delta = _apple_parse(end) - _apple_parse(start)
                    sleep_by_date[end[:10]] += delta.total_seconds() / 3600
                except ValueError:
                    skipped["bad-value"] += 1
        elif rtype:
            skipped[rtype] += 1
        elem.clear()

    for date, total in sorted(steps_by_date.items()):
        entries.append(
            quantity_obs(
                "55423-8", "Steps", "steps", "activity", f"{date}T23:59:00Z", round(total), f"apple|steps|{date}"
            )
        )
    for date, hours in sorted(sleep_by_date.items()):
        entries.append(
            _entry(
                {
                    "resourceType": "Observation",
                    "status": "final",
                    "subject": {"reference": patient_ref},
                    "category": [
                        {
                            "coding": [
                                {
                                    "system": "http://terminology.hl7.org/CodeSystem/observation-category",
                                    "code": "survey",
                                }
                            ]
                        }
                    ],
                    "code": {"coding": [{"system": fc.CS_OBS, "code": "sleep-duration", "display": "Sleep duration"}]},
                    "effectiveDateTime": f"{date}T08:00:00Z",
                    "valueQuantity": {"value": round(hours, 1), "unit": "h", "system": fc.UCUM, "code": "h"},
                },
                _hash_ident(f"apple|sleep|{date}"),
            )
        )
    return entries, dict(skipped)


def _apple_parse(s: str) -> datetime:
    # Apple format: "2026-07-01 23:41:00 +0530"
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S %z")


def _apple_datetime(s: str) -> str:
    try:
        return _apple_parse(s).isoformat(timespec="seconds")
    except ValueError:
        return s


# --- Commit ---------------------------------------------------------------------


def commit_entries(medplum: MedplumFhirClient, entries: list[dict], source_label: str) -> dict[str, Any]:
    imported = existing = 0
    committed_refs: list[str] = []
    for i in range(0, len(entries), CHUNK):
        chunk = entries[i : i + CHUNK]
        result = medplum.post_bundle({"resourceType": "Bundle", "type": "transaction", "entry": chunk})
        for entry in result.get("entry", []):
            status = entry.get("response", {}).get("status", "")
            location = entry.get("response", {}).get("location", "")
            if status.startswith("201"):
                imported += 1
                if location:
                    committed_refs.append("/".join(location.split("/")[:2]))
            elif status.startswith("200"):
                existing += 1
    if committed_refs:
        medplum.create(
            {
                "resourceType": "Provenance",
                "target": [{"reference": ref} for ref in committed_refs[:500]],
                "recorded": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "agent": [
                    {
                        "type": {"text": f"HealMeDaily importer ({source_label})"},
                        "who": {"display": "HealMeDaily import pipeline"},
                    }
                ],
            }
        )
    return {"imported": imported, "already_existed": existing}


def run_import(medplum: MedplumFhirClient, kind: str, data: bytes, patient_id: str) -> dict[str, Any]:
    if kind == "fhir":
        entries, skipped = prepare_fhir_entries(json.loads(data), patient_id)
    elif kind == "csv":
        entries, skipped = prepare_csv_entries(data.decode("utf-8-sig"), patient_id)
    elif kind == "apple":
        entries, skipped = prepare_apple_entries(data, patient_id)
    else:
        raise ValueError(f"unknown import kind '{kind}'")
    summary = commit_entries(medplum, entries, kind) if entries else {"imported": 0, "already_existed": 0}
    return {**summary, "prepared": len(entries), "skipped": skipped}
