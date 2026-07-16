"""Shared FHIR constants — mirrors FHIR-MAPPING.md §1 (this app's local
identifier/CodeSystem/extension URLs under https://healmedaily.local/fhir)
plus the standard terminology URIs. Single source for these strings on the
Python side; the URLs must match FHIR-MAPPING.md and the frontend exactly —
a typo here silently forks the data model. Local codes exist because we
never invent LOINC/SNOMED/RxNorm codes (CLAUDE.md §3): unverifiable concepts
get a local code + original text instead."""

BASE = "https://healmedaily.local/fhir"
IDENT = BASE + "/identifier"  # identifier systems: IDENT + "/<suffix>" (FHIR-MAPPING §7 table)
CS_OBS = BASE + "/CodeSystem/observation"  # local tracker codes: mood, energy, sleep-duration, symptom...
CS_ADHERENCE = BASE + "/CodeSystem/adherence-reason"  # user-skipped / user-marked-missed
CS_DEVICE = BASE + "/CodeSystem/device"  # medication-cartridge etc.
CS_INGEST = BASE + "/CodeSystem/ingestion-task"  # review-queue Task codes (candidate, confidence...)
CS_DOC = BASE + "/CodeSystem/document"  # DocumentReference types: uploaded-document, health-review, nl-capture
CS_AUDIT = BASE + "/CodeSystem/audit"  # AuditEvent.type coding: cloud-egress (subtype = AI feature slug)
EXT_LIFE_CRITICAL = BASE + "/StructureDefinition/medicationrequest-life-critical"  # owner-set only, never inferred
EXT_DEVICE_MED = BASE + "/StructureDefinition/device-assigned-medication"

LOINC = "http://loinc.org"
UCUM = "http://unitsofmeasure.org"

# Required verbatim on every AI summary and PDF (CLAUDE.md §6 AI guardrails).
DISCLAIMER = (
    "Not medical advice — this summary is a discussion aid generated from your own records; "
    "review it with a qualified clinician."
)
