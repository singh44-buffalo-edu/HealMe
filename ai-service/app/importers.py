"""Structured importers: FHIR R4 bundles, observations CSV (our own export
format round-trips), Apple Health export XML, C-CDA documents, and HL7v2
ORU result messages.

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
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any
from xml.etree import ElementTree

from . import fhir_consts as fc
from .medplum import MedplumFhirClient

IMPORT_IDENT = f"{fc.IDENT}/import"
IMPORT_TAG = {"system": f"{fc.BASE}/tags", "code": "imported", "display": "Imported record"}

SNOMED = "http://snomed.info/sct"
RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm"
OBS_CATEGORY = "http://terminology.hl7.org/CodeSystem/observation-category"

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


# --- C-CDA (Consolidated CDA R2 XML) ----------------------------------------------

CDA_NS = "urn:hl7-org:v3"
_V = f"{{{CDA_NS}}}"
XSI_TYPE = "{http://www.w3.org/2001/XMLSchema-instance}type"

# Code-system OIDs we can verify → canonical URIs. Anything else degrades to
# text-only — never present a code under a system we cannot verify.
OID_TO_SYSTEM = {
    "2.16.840.1.113883.6.1": fc.LOINC,
    "2.16.840.1.113883.6.96": SNOMED,
    "2.16.840.1.113883.6.88": RXNORM,
    "2.16.840.1.113883.6.90": "http://hl7.org/fhir/sid/icd-10-cm",
    "2.16.840.1.113883.12.292": "http://hl7.org/fhir/sid/cvx",
    "2.16.840.1.113883.6.8": fc.UCUM,
}

CCDA_SECTIONS = {
    "2.16.840.1.113883.10.20.22.2.3.1": "results",
    "2.16.840.1.113883.10.20.22.2.5.1": "problems",
    "2.16.840.1.113883.10.20.22.2.1.1": "medications",
    "2.16.840.1.113883.10.20.22.2.6.1": "allergies",
    "2.16.840.1.113883.10.20.22.2.2.1": "immunizations",
}


def _ts_iso(ts: str | None) -> str | None:
    """CDA/HL7 TS (`YYYYMMDD[HHMM[SS]][±ZZZZ]`) → FHIR date/dateTime. FHIR
    requires a zone offset once a time is present, so times without an offset
    degrade to date precision — we never invent a time zone."""
    if not ts:
        return None
    ts = ts.strip()
    tz = ""
    for sign in ("+", "-"):
        idx = ts.find(sign)
        if idx > 7:
            ts, tz = ts[:idx], ts[idx:]
            break
    ts = ts.split(".")[0]
    if len(ts) < 8 or not ts[:8].isdigit():
        return None
    date = f"{ts[0:4]}-{ts[4:6]}-{ts[6:8]}"
    time_part = ts[8:]
    if len(time_part) >= 4 and time_part.isdigit() and len(tz) == 5:
        seconds = time_part[4:6] if len(time_part) >= 6 else "00"
        return f"{date}T{time_part[0:2]}:{time_part[2:4]}:{seconds}{tz[:3]}:{tz[3:]}"
    return date


def _cda_concept(el: ElementTree.Element | None) -> dict[str, Any] | None:
    """CDA coded element → CodeableConcept. Codes keep a `coding` only when
    the source OID maps to a known system URI; unmapped OIDs are text-only."""
    if el is None:
        return None
    code = el.get("code")
    system = OID_TO_SYSTEM.get(el.get("codeSystem", ""))
    display = el.get("displayName")
    concept: dict[str, Any] = {}
    if code and system:
        coding: dict[str, str] = {"system": system, "code": code}
        if display:
            coding["display"] = display
        concept["coding"] = [coding]
    if display:
        concept["text"] = display
    return concept or None


def _cda_low_or_value(el: ElementTree.Element | None) -> str | None:
    """effectiveTime@value, falling back to its <low> child."""
    if el is None:
        return None
    when = _ts_iso(el.get("value"))
    if when:
        return when
    low = el.find(f"{_V}low")
    return _ts_iso(low.get("value")) if low is not None else None


def _cda_quantity(el: ElementTree.Element | None) -> dict[str, Any] | None:
    if el is None or not el.get("value"):
        return None
    try:
        quantity: dict[str, Any] = {"value": float(el.get("value", ""))}
    except ValueError:
        return None
    if el.get("unit") and el.get("unit") != "1":
        quantity["unit"] = el.get("unit")
    return quantity


def _concept_key(concept: dict[str, Any]) -> str:
    return json.dumps(concept, sort_keys=True)


def _ccda_results(section: ElementTree.Element, patient_ref: str, entries: list[dict], skipped: dict[str, int]):
    for obs_el in section.iter(f"{_V}observation"):
        concept = _cda_concept(obs_el.find(f"{_V}code"))
        value_el = obs_el.find(f"{_V}value")
        if concept is None or value_el is None:
            skipped["result-incomplete"] += 1
            continue
        obs: dict[str, Any] = {
            "resourceType": "Observation",
            "status": "final",
            "subject": {"reference": patient_ref},
            "category": [{"coding": [{"system": OBS_CATEGORY, "code": "laboratory"}]}],
            "code": concept,
        }
        when = _cda_low_or_value(obs_el.find(f"{_V}effectiveTime"))
        if when:
            obs["effectiveDateTime"] = when
        vtype = value_el.get(XSI_TYPE, "")
        if vtype == "PQ":
            quantity = _cda_quantity(value_el)
            if quantity is None:
                skipped["result-bad-value"] += 1
                continue
            obs["valueQuantity"] = quantity
        elif vtype == "CD":
            value_concept = _cda_concept(value_el)
            if value_concept is None:
                skipped["result-bad-value"] += 1
                continue
            obs["valueCodeableConcept"] = value_concept
        elif value_el.text and value_el.text.strip():
            obs["valueString"] = value_el.text.strip()
        else:
            skipped["result-bad-value"] += 1
            continue
        rr = obs_el.find(f"{_V}referenceRange/{_V}observationRange")
        if rr is not None:
            rr_range: dict[str, Any] = {}
            rr_value = rr.find(f"{_V}value")
            if rr_value is not None:
                for key in ("low", "high"):
                    quantity = _cda_quantity(rr_value.find(f"{_V}{key}"))
                    if quantity:
                        rr_range[key] = quantity
            rr_text = rr.find(f"{_V}text")
            if not rr_range and rr_text is not None and rr_text.text:
                rr_range["text"] = rr_text.text.strip()
            if rr_range:
                obs["referenceRange"] = [rr_range]
        value_key = obs.get("valueQuantity") or obs.get("valueString") or obs.get("valueCodeableConcept")
        ident = _hash_ident(f"ccda|result|{_concept_key(concept)}|{when}|{json.dumps(value_key, sort_keys=True)}")
        entries.append(_entry(obs, ident))


def _ccda_problems(section: ElementTree.Element, patient_ref: str, entries: list[dict], skipped: dict[str, int]):
    for obs_el in section.iter(f"{_V}observation"):
        concept = _cda_concept(obs_el.find(f"{_V}value"))
        if concept is None:
            skipped["problem-uncoded"] += 1
            continue
        condition: dict[str, Any] = {
            "resourceType": "Condition",
            "subject": {"reference": patient_ref},
            "category": [
                {
                    "coding": [
                        {
                            "system": "http://terminology.hl7.org/CodeSystem/condition-category",
                            "code": "problem-list-item",
                        }
                    ]
                }
            ],
            "code": concept,
        }
        onset = _cda_low_or_value(obs_el.find(f"{_V}effectiveTime"))
        if onset:
            condition["onsetDateTime"] = onset
        entries.append(_entry(condition, _hash_ident(f"ccda|problem|{_concept_key(concept)}|{onset}")))


def _ccda_medications(section: ElementTree.Element, patient_ref: str, entries: list[dict], skipped: dict[str, int]):
    status_map = {"active": "active", "completed": "completed", "aborted": "stopped", "suspended": "on-hold"}
    for sa in section.iter(f"{_V}substanceAdministration"):
        concept = _cda_concept(sa.find(f".//{_V}manufacturedMaterial/{_V}code"))
        if concept is None:
            skipped["medication-uncoded"] += 1
            continue
        status_el = sa.find(f"{_V}statusCode")
        status = status_map.get(status_el.get("code", "") if status_el is not None else "", "unknown")
        statement: dict[str, Any] = {
            "resourceType": "MedicationStatement",
            "status": status,
            "medicationCodeableConcept": concept,
            "subject": {"reference": patient_ref},
        }
        period: dict[str, str] = {}
        for et in sa.findall(f"{_V}effectiveTime"):
            low, high = et.find(f"{_V}low"), et.find(f"{_V}high")
            if low is None and high is None:
                continue
            start = _ts_iso(low.get("value")) if low is not None else None
            end = _ts_iso(high.get("value")) if high is not None else None
            if start:
                period["start"] = start
            if end:
                period["end"] = end
            break
        if period:
            statement["effectivePeriod"] = period
        ident = _hash_ident(f"ccda|medication|{_concept_key(concept)}|{period.get('start')}")
        entries.append(_entry(statement, ident))


def _ccda_allergies(section: ElementTree.Element, patient_ref: str, entries: list[dict], skipped: dict[str, int]):
    for obs_el in section.iter(f"{_V}observation"):
        concept = _cda_concept(obs_el.find(f".//{_V}playingEntity/{_V}code"))
        if concept is None:
            skipped["allergy-uncoded"] += 1
            continue
        allergy: dict[str, Any] = {
            "resourceType": "AllergyIntolerance",
            "patient": {"reference": patient_ref},
            "code": concept,
        }
        onset = _cda_low_or_value(obs_el.find(f"{_V}effectiveTime"))
        if onset:
            allergy["onsetDateTime"] = onset
        entries.append(_entry(allergy, _hash_ident(f"ccda|allergy|{_concept_key(concept)}|{onset}")))


def _ccda_immunizations(section: ElementTree.Element, patient_ref: str, entries: list[dict], skipped: dict[str, int]):
    for sa in section.iter(f"{_V}substanceAdministration"):
        concept = _cda_concept(sa.find(f".//{_V}manufacturedMaterial/{_V}code"))
        if concept is None:
            skipped["immunization-uncoded"] += 1
            continue
        when = _cda_low_or_value(sa.find(f"{_V}effectiveTime"))
        immunization: dict[str, Any] = {
            "resourceType": "Immunization",
            "status": "not-done" if sa.get("negationInd") == "true" else "completed",
            "vaccineCode": concept,
            "patient": {"reference": patient_ref},
        }
        if when:
            immunization["occurrenceDateTime"] = when
        else:
            immunization["occurrenceString"] = "unknown"
        entries.append(_entry(immunization, _hash_ident(f"ccda|immunization|{_concept_key(concept)}|{when}")))


_CCDA_HANDLERS = {
    "results": _ccda_results,
    "problems": _ccda_problems,
    "medications": _ccda_medications,
    "allergies": _ccda_allergies,
    "immunizations": _ccda_immunizations,
}


def _looks_xml(data: bytes) -> bool:
    return data.lstrip()[:1] == b"<"


def is_clinical_document(data: bytes) -> bool:
    """True when the bytes parse as XML with a CDA ClinicalDocument root."""
    try:
        for _, elem in ElementTree.iterparse(io.BytesIO(data), events=("start",)):
            return elem.tag == f"{_V}ClinicalDocument"
    except ElementTree.ParseError:
        return False
    return False


def prepare_ccda_entries(xml_bytes: bytes, patient_id: str) -> tuple[list[dict], dict[str, int]]:
    """Parse a C-CDA (CDA R2) document. Structured sections we understand —
    Results, Problems, Medications, Allergies, Immunizations — become FHIR
    resources; every other section is skipped silently."""
    try:
        root = ElementTree.fromstring(xml_bytes)
    except ElementTree.ParseError as err:
        raise ValueError("not a C-CDA document") from err
    if root.tag != f"{_V}ClinicalDocument":
        raise ValueError("not a C-CDA document")
    patient_ref = f"Patient/{patient_id}"
    entries: list[dict] = []
    skipped: dict[str, int] = defaultdict(int)
    for section in root.iter(f"{_V}section"):
        kinds = {CCDA_SECTIONS.get(t.get("root", "")) for t in section.findall(f"{_V}templateId")}
        kind = next((k for k in kinds if k), None)
        if kind:
            _CCDA_HANDLERS[kind](section, patient_ref, entries, skipped)
    return entries, dict(skipped)


# --- HL7v2 ORU^R01 (pipe-delimited ER7) --------------------------------------------


def _split_hl7_messages(text: str) -> list[list[str]]:
    lines = [ln.strip() for ln in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    messages: list[list[str]] = []
    for line in lines:
        if not line:
            continue
        if line.startswith("MSH"):
            messages.append([line])
        elif messages:
            messages[-1].append(line)
    if not messages:
        raise ValueError("not an HL7v2 message — no MSH segment found")
    return messages


def prepare_hl7_entries(text: str, patient_id: str) -> tuple[list[dict], dict[str, int]]:
    """Parse HL7v2 ORU^R01 result messages: each OBX becomes an Observation
    and each OBR a DiagnosticReport referencing its Observations. Non-ORU
    messages are rejected."""
    patient_ref = f"Patient/{patient_id}"
    entries: list[dict] = []
    skipped: dict[str, int] = defaultdict(int)

    for segments in _split_hl7_messages(text):
        msh = segments[0]
        if len(msh) < 5:
            raise ValueError("not an HL7v2 message — MSH segment is truncated")
        field_sep = msh[3]
        msh_fields = msh.split(field_sep)
        encoding = msh_fields[1] if len(msh_fields) > 1 and msh_fields[1] else "^~\\&"
        comp_sep = encoding[0]
        rep_sep = encoding[1] if len(encoding) > 1 else "~"
        esc = encoding[2] if len(encoding) > 2 else "\\"
        sub_sep = encoding[3] if len(encoding) > 3 else "&"

        def unescape(value: str) -> str:
            if esc not in value:
                return value
            for seq, char in (
                (f"{esc}F{esc}", field_sep),
                (f"{esc}S{esc}", comp_sep),
                (f"{esc}R{esc}", rep_sep),
                (f"{esc}T{esc}", sub_sep),
                (f"{esc}E{esc}", esc),
            ):
                value = value.replace(seq, char)
            return value

        def concept(field: str) -> dict[str, Any] | None:
            """CE/CWE field → CodeableConcept. Only 'LN' (LOINC) is a verified
            system; anything else keeps the raw code under our local system."""
            comps = field.split(comp_sep)
            code = unescape(comps[0]) if comps[0] else ""
            label = unescape(comps[1]) if len(comps) > 1 and comps[1] else ""
            system_id = comps[2] if len(comps) > 2 else ""
            if not code and not label:
                return None
            result: dict[str, Any] = {"text": label or code}
            if code:
                system = fc.LOINC if system_id == "LN" else fc.CS_OBS
                coding = {"system": system, "code": code}
                if label:
                    coding["display"] = label
                result["coding"] = [coding]
            return result

        msg_type = msh_fields[8] if len(msh_fields) > 8 else ""
        if msg_type.split(comp_sep)[0] != "ORU":
            raise ValueError(
                f"unsupported HL7 message type '{msg_type or 'unknown'}' — only ORU (results) is supported"
            )

        # group OBX segments under their preceding OBR
        groups: list[tuple[list[str] | None, list[list[str]]]] = []
        for segment in segments[1:]:
            fields = segment.split(field_sep)
            if fields[0] == "OBR":
                groups.append((fields, []))
            elif fields[0] == "OBX":
                if not groups:
                    groups.append((None, []))
                groups[-1][1].append(fields)

        def field(fields: list[str], index: int) -> str:
            return fields[index] if index < len(fields) else ""

        for obr, obx_list in groups:
            obr_when = _ts_iso(field(obr, 7)) if obr else None
            obr_key = "|".join(field(obr, i) for i in (2, 3, 4, 7)) if obr else ""
            obs_refs: list[str] = []
            for obx in obx_list:
                obs_concept = concept(field(obx, 3))
                if obs_concept is None:
                    skipped["obx-no-code"] += 1
                    continue
                vtype = field(obx, 2)
                value_raw = unescape(field(obx, 5).split(rep_sep)[0])
                if not value_raw:
                    skipped["obx-no-value"] += 1
                    continue
                unit = unescape(field(obx, 6).split(comp_sep)[0])
                obs: dict[str, Any] = {
                    "resourceType": "Observation",
                    "status": {"P": "preliminary", "C": "corrected"}.get(field(obx, 11), "final"),
                    "subject": {"reference": patient_ref},
                    "category": [{"coding": [{"system": OBS_CATEGORY, "code": "laboratory"}]}],
                    "code": obs_concept,
                }
                if vtype == "NM":
                    try:
                        quantity: dict[str, Any] = {"value": float(value_raw)}
                    except ValueError:
                        skipped["obx-bad-value"] += 1
                        continue
                    if unit:
                        quantity["unit"] = unit
                    obs["valueQuantity"] = quantity
                elif vtype in ("ST", "TX", "FT"):
                    obs["valueString"] = value_raw
                else:
                    skipped[f"obx-type-{vtype or 'unknown'}"] += 1
                    continue
                when = _ts_iso(field(obx, 14)) or obr_when
                if when:
                    obs["effectiveDateTime"] = when
                ref_range = field(obx, 7)
                if ref_range:
                    low_raw, _, high_raw = ref_range.partition("-")
                    try:
                        low_q: dict[str, Any] = {"value": float(low_raw)}
                        high_q: dict[str, Any] = {"value": float(high_raw)}
                        if unit:
                            low_q["unit"] = high_q["unit"] = unit
                        obs["referenceRange"] = [{"low": low_q, "high": high_q}]
                    except ValueError:
                        obs["referenceRange"] = [{"text": ref_range}]
                ident = _hash_ident(f"hl7|obx|{obr_key}|{field_sep.join(obx)}")
                full_url = f"urn:uuid:{uuid.UUID(ident['value'])}"
                obs_refs.append(full_url)
                entries.append(_entry(obs, ident, full_url=full_url))
            if obr and obs_refs:
                report: dict[str, Any] = {
                    "resourceType": "DiagnosticReport",
                    "status": "final",
                    "subject": {"reference": patient_ref},
                    "code": concept(field(obr, 4)) or {"text": "Laboratory report"},
                    "result": [{"reference": ref} for ref in obs_refs],
                }
                if obr_when:
                    report["effectiveDateTime"] = obr_when
                section_id = field(obr, 24)
                if section_id:
                    report["category"] = [
                        {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/v2-0074", "code": section_id}]}
                    ]
                entries.append(_entry(report, _hash_ident(f"hl7|obr|{field_sep.join(obr)}")))
            elif obr:
                skipped["obr-empty"] += 1
    return entries, dict(skipped)


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
    if kind in ("apple", "fhir") and is_clinical_document(data):
        kind = "ccda"  # .xml files default to apple/fhir upstream — sniff and reroute C-CDA
    if kind == "fhir":
        try:
            bundle = json.loads(data)
        except json.JSONDecodeError as err:
            hint = " — XML file? use the ccda (C-CDA) or apple (Apple Health) import kind" if _looks_xml(data) else ""
            raise ValueError(f"not a JSON FHIR Bundle{hint}") from err
        entries, skipped = prepare_fhir_entries(bundle, patient_id)
    elif kind == "csv":
        entries, skipped = prepare_csv_entries(data.decode("utf-8-sig"), patient_id)
    elif kind == "apple":
        entries, skipped = prepare_apple_entries(data, patient_id)
    elif kind == "ccda":
        entries, skipped = prepare_ccda_entries(data, patient_id)
    elif kind == "hl7":
        entries, skipped = prepare_hl7_entries(data.decode("utf-8-sig"), patient_id)
    else:
        raise ValueError(f"unknown import kind '{kind}'")
    summary = commit_entries(medplum, entries, kind) if entries else {"imported": 0, "already_existed": 0}
    return {**summary, "prepared": len(entries), "skipped": skipped}
