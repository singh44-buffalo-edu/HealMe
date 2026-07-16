"""Deterministic importers (FHIR bundle / CSV / Apple Health): pure prepare_*
functions only — patient retargeting, content-hash dedup identifiers +
If-None-Exist, unit conversions and per-date aggregation, and rejection of
wrong-format files. No I/O, no Medplum."""

from app import importers

PATIENT = "p-123"


def test_fhir_bundle_prepare_retargets_and_dedups():
    bundle = {
        "resourceType": "Bundle",
        "type": "collection",
        "entry": [
            {
                "fullUrl": "urn:uuid:obs-1",
                "resource": {
                    "resourceType": "Observation",
                    "id": "old-id",
                    "status": "final",
                    "subject": {"reference": "Patient/someone-else"},
                    "encounter": {"reference": "Encounter/not-in-bundle"},
                    "code": {"text": "Hemoglobin"},
                    "valueQuantity": {"value": 13.1, "unit": "g/dL"},
                },
            },
            {
                "fullUrl": "urn:uuid:report-1",
                "resource": {
                    "resourceType": "DiagnosticReport",
                    "status": "final",
                    "subject": {"reference": "Patient/someone-else"},
                    "code": {"text": "CBC"},
                    "result": [{"reference": "urn:uuid:obs-1"}],
                },
            },
            {"resource": {"resourceType": "Appointment", "status": "booked"}},
        ],
    }
    entries, skipped = importers.prepare_fhir_entries(bundle, PATIENT)
    assert len(entries) == 2
    assert skipped == {"Appointment": 1}

    obs = entries[0]["resource"]
    assert obs["subject"] == {"reference": f"Patient/{PATIENT}"}
    assert "id" not in obs
    assert "encounter" not in obs  # dangling external reference dropped
    assert any(i["system"] == importers.IMPORT_IDENT for i in obs["identifier"])
    assert entries[0]["request"]["ifNoneExist"].startswith(f"identifier={importers.IMPORT_IDENT}|")

    report = entries[1]["resource"]
    assert report["result"] == [{"reference": "urn:uuid:obs-1"}]  # intra-bundle ref kept
    assert entries[1]["fullUrl"] == "urn:uuid:report-1"


def test_fhir_rejects_non_bundle():
    try:
        importers.prepare_fhir_entries({"resourceType": "Patient"}, PATIENT)
        raise AssertionError("should have raised")
    except ValueError:
        pass


def test_csv_prepare_maps_quantities_and_strings():
    text = (
        "id,effective,code_system,code,display,value,unit,status,category\n"
        "x,2026-06-01T08:00:00Z,http://loinc.org,29463-7,Body weight,70.5,kg,final,vital-signs\n"
        "y,2026-06-02T20:00:00Z,,symptom,Symptom,mild headache,,final,survey\n"
        "z,,,29463-7,Body weight,71,kg,final,vital-signs\n"  # missing effective -> skipped
    )
    entries, skipped = importers.prepare_csv_entries(text, PATIENT)
    assert len(entries) == 2
    assert skipped == {"missing-fields": 1}
    weight, symptom = entries[0]["resource"], entries[1]["resource"]
    assert weight["valueQuantity"]["value"] == 70.5
    assert weight["category"][0]["coding"][0]["code"] == "vital-signs"
    assert symptom["valueString"] == "mild headache"

    # deterministic dedup identifier: same row -> same identifier value
    again, _ = importers.prepare_csv_entries(text, PATIENT)
    assert entries[0]["request"]["ifNoneExist"] == again[0]["request"]["ifNoneExist"]


def test_csv_rejects_wrong_headers():
    try:
        importers.prepare_csv_entries("a,b,c\n1,2,3\n", PATIENT)
        raise AssertionError("should have raised")
    except ValueError:
        pass


APPLE_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<HealthData>
 <Record type="HKQuantityTypeIdentifierBodyMass" unit="lb" value="155.4"
   startDate="2026-06-01 08:00:00 +0530" endDate="2026-06-01 08:00:00 +0530"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" value="62"
   startDate="2026-06-01 09:00:00 +0530" endDate="2026-06-01 09:00:00 +0530"/>
 <Record type="HKQuantityTypeIdentifierStepCount" value="4000"
   startDate="2026-06-01 10:00:00 +0530" endDate="2026-06-01 11:00:00 +0530"/>
 <Record type="HKQuantityTypeIdentifierStepCount" value="2500"
   startDate="2026-06-01 15:00:00 +0530" endDate="2026-06-01 16:00:00 +0530"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" value="HKCategoryValueSleepAnalysisAsleepCore"
   startDate="2026-06-01 23:30:00 +0530" endDate="2026-06-02 06:00:00 +0530"/>
 <Record type="HKQuantityTypeIdentifierDietaryWater" value="1"
   startDate="2026-06-01 12:00:00 +0530" endDate="2026-06-01 12:00:00 +0530"/>
</HealthData>
"""


def test_apple_prepare_converts_aggregates_and_skips():
    entries, skipped = importers.prepare_apple_entries(APPLE_XML, PATIENT)
    by_code = {e["resource"]["code"]["coding"][0]["code"]: e["resource"] for e in entries}

    assert round(by_code["29463-7"]["valueQuantity"]["value"], 1) == 70.5  # lb -> kg
    assert by_code["8867-4"]["valueQuantity"]["value"] == 62
    assert by_code["55423-8"]["valueQuantity"]["value"] == 6500  # daily aggregate
    assert by_code["sleep-duration"]["valueQuantity"]["value"] == 6.5
    assert skipped == {"HKQuantityTypeIdentifierDietaryWater": 1}
    # timezone preserved
    assert by_code["29463-7"]["effectiveDateTime"] == "2026-06-01T08:00:00+05:30"
