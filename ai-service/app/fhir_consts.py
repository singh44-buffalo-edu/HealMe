"""Shared FHIR constants — mirrors FHIR-MAPPING.md."""

BASE = "https://healmedaily.local/fhir"
IDENT = BASE + "/identifier"
CS_OBS = BASE + "/CodeSystem/observation"
CS_ADHERENCE = BASE + "/CodeSystem/adherence-reason"
CS_DEVICE = BASE + "/CodeSystem/device"
CS_INGEST = BASE + "/CodeSystem/ingestion-task"
CS_DOC = BASE + "/CodeSystem/document"
EXT_LIFE_CRITICAL = BASE + "/StructureDefinition/medicationrequest-life-critical"
EXT_DEVICE_MED = BASE + "/StructureDefinition/device-assigned-medication"

LOINC = "http://loinc.org"
UCUM = "http://unitsofmeasure.org"

DISCLAIMER = (
    "Not medical advice — this summary is a discussion aid generated from your own records; "
    "review it with a qualified clinician."
)
