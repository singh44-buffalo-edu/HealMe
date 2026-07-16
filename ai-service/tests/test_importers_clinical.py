"""C-CDA and HL7v2 ORU importers — parse counts, code-system mapping,
dedup identifiers, and rejection paths. No live Medplum involved."""

from pathlib import Path

import pytest

from app import fhir_consts as fc
from app import importers

PATIENT = "p-123"
FIXTURES = Path(__file__).parent / "fixtures"
CCDA_BYTES = (FIXTURES / "sample_ccda.xml").read_bytes()
ORU_TEXT = (FIXTURES / "sample_oru.hl7").read_text()


def _by_type(entries: list[dict]) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = {}
    for e in entries:
        grouped.setdefault(e["resource"]["resourceType"], []).append(e["resource"])
    return grouped


# --- C-CDA -----------------------------------------------------------------------


def test_ccda_parses_all_known_sections():
    entries, skipped = importers.prepare_ccda_entries(CCDA_BYTES, PATIENT)
    grouped = _by_type(entries)
    assert len(grouped["Observation"]) == 2
    assert len(grouped["Condition"]) == 1
    assert len(grouped["MedicationStatement"]) == 1
    assert len(grouped["AllergyIntolerance"]) == 1
    assert len(grouped["Immunization"]) == 1
    assert skipped == {}  # unknown sections (Social History) skipped silently, not counted


def test_ccda_result_observation_details():
    entries, _ = importers.prepare_ccda_entries(CCDA_BYTES, PATIENT)
    glucose = next(e for e in entries if e["resource"].get("code", {}).get("text") == "Glucose")
    obs = glucose["resource"]
    assert obs["code"]["coding"] == [{"system": fc.LOINC, "code": "2345-7", "display": "Glucose"}]
    assert obs["subject"] == {"reference": f"Patient/{PATIENT}"}
    assert obs["category"][0]["coding"][0]["code"] == "laboratory"
    assert obs["valueQuantity"] == {"value": 92.0, "unit": "mg/dL"}
    assert obs["effectiveDateTime"] == "2026-07-01T08:30:00+00:00"
    assert obs["referenceRange"] == [
        {"low": {"value": 70.0, "unit": "mg/dL"}, "high": {"value": 99.0, "unit": "mg/dL"}}
    ]
    assert any(i["system"] == importers.IMPORT_IDENT for i in obs["identifier"])
    assert glucose["request"]["ifNoneExist"].startswith(f"identifier={importers.IMPORT_IDENT}|")


def test_ccda_code_systems_mapped_from_oids():
    entries, _ = importers.prepare_ccda_entries(CCDA_BYTES, PATIENT)
    grouped = _by_type(entries)

    condition = grouped["Condition"][0]
    assert condition["code"]["coding"][0] == {
        "system": "http://snomed.info/sct",
        "code": "38341003",
        "display": "Hypertensive disorder",
    }
    assert condition["onsetDateTime"] == "2024-01-10"

    med = grouped["MedicationStatement"][0]
    assert med["medicationCodeableConcept"]["coding"][0]["system"] == importers.RXNORM
    assert med["medicationCodeableConcept"]["coding"][0]["code"] == "197361"
    assert med["status"] == "active"
    assert med["effectivePeriod"] == {"start": "2025-03-01"}

    allergy = grouped["AllergyIntolerance"][0]
    assert allergy["patient"] == {"reference": f"Patient/{PATIENT}"}
    assert allergy["code"]["coding"][0]["system"] == importers.RXNORM
    assert allergy["code"]["text"] == "Penicillin"

    imm = grouped["Immunization"][0]
    assert imm["vaccineCode"]["coding"][0]["system"] == "http://hl7.org/fhir/sid/cvx"
    assert imm["status"] == "completed"
    assert imm["occurrenceDateTime"] == "2025-10-15"


UNMAPPED_OID_CCDA = b"""<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <component><structuredBody><component><section>
  <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
  <entry><organizer><component><observation>
    <code code="XYZ-1" codeSystem="1.2.3.4.5" displayName="Proprietary marker"/>
    <effectiveTime value="20260701"/>
    <value xsi:type="PQ" value="5" unit="U"/>
  </observation></component></organizer></entry>
 </section></component></structuredBody></component>
</ClinicalDocument>"""


def test_ccda_unmapped_oid_becomes_text_only():
    entries, _ = importers.prepare_ccda_entries(UNMAPPED_OID_CCDA, PATIENT)
    assert len(entries) == 1
    code = entries[0]["resource"]["code"]
    assert code == {"text": "Proprietary marker"}  # no coding — never a fake system


def test_ccda_dedup_same_file_same_identifiers():
    first, _ = importers.prepare_ccda_entries(CCDA_BYTES, PATIENT)
    second, _ = importers.prepare_ccda_entries(CCDA_BYTES, PATIENT)
    assert [e["request"]["ifNoneExist"] for e in first] == [e["request"]["ifNoneExist"] for e in second]


def test_ccda_rejects_non_cda_input():
    with pytest.raises(ValueError, match="not a C-CDA document"):
        importers.prepare_ccda_entries(b"definitely {not} xml", PATIENT)
    with pytest.raises(ValueError, match="not a C-CDA document"):
        importers.prepare_ccda_entries(b"<HealthData/>", PATIENT)  # XML, wrong root


# --- HL7v2 ORU ---------------------------------------------------------------------


def test_hl7_oru_observations_and_report():
    entries, skipped = importers.prepare_hl7_entries(ORU_TEXT, PATIENT)
    grouped = _by_type(entries)
    assert len(grouped["Observation"]) == 2
    assert len(grouped["DiagnosticReport"]) == 1
    assert skipped == {}

    glucose = grouped["Observation"][0]
    assert glucose["code"]["coding"] == [{"system": fc.LOINC, "code": "2345-7", "display": "Glucose"}]
    assert glucose["valueQuantity"] == {"value": 92.0, "unit": "mg/dL"}
    assert glucose["effectiveDateTime"] == "2026-07-10T08:00:00+00:00"
    assert glucose["referenceRange"] == [
        {"low": {"value": 70.0, "unit": "mg/dL"}, "high": {"value": 99.0, "unit": "mg/dL"}}
    ]
    assert glucose["status"] == "final"

    report = grouped["DiagnosticReport"][0]
    assert report["code"]["coding"][0] == {
        "system": fc.LOINC,
        "code": "24323-8",
        "display": "Comprehensive metabolic panel",
    }
    assert report["category"][0]["coding"][0] == {
        "system": "http://terminology.hl7.org/CodeSystem/v2-0074",
        "code": "LAB",
    }
    # report references its observations through intra-bundle urn:uuid fullUrls
    obs_urls = [e["fullUrl"] for e in entries if e["resource"]["resourceType"] == "Observation"]
    assert all(url.startswith("urn:uuid:") for url in obs_urls)
    assert report["result"] == [{"reference": url} for url in obs_urls]


LOCAL_CODED_ORU = (
    "MSH|^~\\&|LAB|X|Y|Z|20260101120000+0000||ORU^R01|MSG2|P|2.3\r"
    "OBR|1|||PANEL^House panel^L|||20260101110000+0000\r"
    "OBX|1|ST|GLU^Glucose dipstick^L||negative||||||F\r"
)


def test_hl7_non_loinc_codes_go_to_local_system():
    entries, _ = importers.prepare_hl7_entries(LOCAL_CODED_ORU, PATIENT)
    obs = entries[0]["resource"]
    assert obs["code"]["coding"] == [{"system": fc.CS_OBS, "code": "GLU", "display": "Glucose dipstick"}]
    assert obs["code"]["text"] == "Glucose dipstick"
    assert obs["valueString"] == "negative"
    assert obs["effectiveDateTime"] == "2026-01-01T11:00:00+00:00"  # falls back to OBR-7


def test_hl7_rejects_non_oru_messages():
    adt = "MSH|^~\\&|HOSP|A|B|C|20260101||ADT^A01|MSG3|P|2.3\rPID|1||12345\r"
    with pytest.raises(ValueError, match="ADT"):
        importers.prepare_hl7_entries(adt, PATIENT)


def test_hl7_rejects_input_without_msh():
    with pytest.raises(ValueError, match="MSH"):
        importers.prepare_hl7_entries("this is a lab report PDF pasted as text", PATIENT)


def test_hl7_dedup_same_file_same_identifiers():
    first, _ = importers.prepare_hl7_entries(ORU_TEXT, PATIENT)
    second, _ = importers.prepare_hl7_entries(ORU_TEXT, PATIENT)
    assert [e["request"]["ifNoneExist"] for e in first] == [e["request"]["ifNoneExist"] for e in second]


# --- Wiring ------------------------------------------------------------------------


def test_run_import_sniffs_ccda_even_when_called_as_apple(monkeypatch):
    committed: dict = {}

    def fake_commit(medplum, entries, source_label):
        committed["label"] = source_label
        committed["count"] = len(entries)
        return {"imported": len(entries), "already_existed": 0}

    monkeypatch.setattr(importers, "commit_entries", fake_commit)
    result = importers.run_import(None, "apple", CCDA_BYTES, PATIENT)
    assert committed["label"] == "ccda"  # ClinicalDocument root rerouted from apple to ccda
    assert result["prepared"] == committed["count"] == 6


def test_run_import_fhir_json_error_suggests_ccda():
    with pytest.raises(ValueError, match="ccda"):
        importers.run_import(None, "fhir", b"<SomeOtherXml/>", PATIENT)


def test_import_kinds_and_watcher_extensions_wired():
    from app import main, watcher

    assert {"ccda", "hl7"} <= main.IMPORT_KINDS
    assert watcher.STRUCTURED[".cda"] == "ccda"
    assert watcher.STRUCTURED[".ccda"] == "ccda"
    assert watcher.STRUCTURED[".hl7"] == "hl7"
    assert watcher.STRUCTURED[".xml"] == "apple"  # backward compat; server sniff reroutes C-CDA
