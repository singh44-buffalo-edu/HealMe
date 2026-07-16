"""Export completeness guarantees: EXPORT_TYPES covers every resource type the
app writes (the drift that silently dropped Communication/CommunicationRequest/
MedicationDispense from "the user owns everything" must not repeat), pagination
goes through medplum.search_all (next-link cursor, not the _offset loop that
broke past Medplum's 10 000 cap), and a type that exceeds the page ceiling is
marked with a truncation tag in the bundle meta instead of silence."""

from app import export

# Resource types written as record data anywhere in this repo, mapped to their
# writers. When a new phase writes a new type: add it HERE and to EXPORT_TYPES
# (or to the documented-exclusions comment above EXPORT_TYPES if it is
# genuinely not record data, like AuditEvent/Binary).
WRITTEN_RECORD_TYPES = {
    "Patient",  # scripts/seed.py
    "Medication",  # frontend meds config
    "MedicationRequest",  # frontend meds config
    "MedicationAdministration",  # frontend dose log + pi-dispenser
    "MedicationDispense",  # pi-dispenser/events.py
    "MedicationStatement",  # ingestion proposals
    "Observation",  # check-ins, trackers, importers
    "Condition",  # frontend + proposals
    "AllergyIntolerance",  # importers + proposals
    "Immunization",  # importers + proposals
    "Procedure",  # importers + proposals
    "DiagnosticReport",  # importers (HL7v2 ORU) + proposals
    "DocumentReference",  # ingest originals, health reviews, nl-capture
    "Questionnaire",  # seed + question bank
    "QuestionnaireResponse",  # check-ins
    "Device",  # cartridges, dispenser
    "SupplyDelivery",  # cartridge refills
    "Provenance",  # ingestion commits, importers, pi-dispenser
    "Task",  # review queue, follow-up bot
    "Communication",  # assistant Q&A sessions (assistant.py)
    "CommunicationRequest",  # reminders-runner bot + pi-dispenser escalations
    "Basic",  # alert-rule prefs + share-expiry markers (care_circle)
}


class FakeMedplum:
    """Serves canned per-type resource lists through the search_all interface."""

    def __init__(self, resources=None, truncated_types=()):
        self._resources = resources or {}
        self._truncated = set(truncated_types)
        self.calls = []

    def search_all(self, resource_type, params, max_pages=100):
        self.calls.append({"type": resource_type, "params": dict(params), "max_pages": max_pages})
        return list(self._resources.get(resource_type, [])), resource_type in self._truncated


def test_export_types_cover_everything_the_app_writes():
    assert WRITTEN_RECORD_TYPES <= set(export.EXPORT_TYPES), (
        "EXPORT_TYPES drifted: written record types missing from the export — "
        f"{sorted(WRITTEN_RECORD_TYPES - set(export.EXPORT_TYPES))}"
    )


def test_export_bundle_paginates_via_search_all_and_counts():
    fake = FakeMedplum(
        {
            "Patient": [{"resourceType": "Patient", "id": "p1"}],
            "Communication": [{"resourceType": "Communication", "id": "c1"}],
        }
    )
    bundle = export.export_fhir_bundle(fake)
    assert bundle["resourceType"] == "Bundle"
    assert bundle["type"] == "collection"
    assert bundle["total"] == 2
    assert {e["resource"]["id"] for e in bundle["entry"]} == {"p1", "c1"}
    # Every export type was fetched through the next-link helper with the
    # stable sort and the documented ceiling.
    assert [c["type"] for c in fake.calls] == export.EXPORT_TYPES
    assert all(c["params"] == {"_count": 1000, "_sort": "_lastUpdated"} for c in fake.calls)
    assert all(c["max_pages"] == export.MAX_PAGES_PER_TYPE for c in fake.calls)
    assert bundle["meta"]["tag"] == [{"system": export.TAGS, "code": "full-export"}]


def test_export_bundle_tags_truncated_types():
    fake = FakeMedplum(
        {"Observation": [{"resourceType": "Observation", "id": "o1"}]},
        truncated_types={"Observation"},
    )
    bundle = export.export_fhir_bundle(fake)
    # Partial data is exported, but the bundle says so machine-readably.
    assert {"system": export.TAGS, "code": "truncated-Observation"} in bundle["meta"]["tag"]
    assert {"system": export.TAGS, "code": "full-export"} in bundle["meta"]["tag"]


def test_observations_csv_round_trip_columns():
    fake = FakeMedplum(
        {
            "Observation": [
                {
                    "resourceType": "Observation",
                    "id": "o1",
                    "status": "final",
                    "effectiveDateTime": "2026-07-10T08:30:00Z",
                    "code": {"coding": [{"system": "http://loinc.org", "code": "29463-7"}], "text": "Body weight"},
                    "valueQuantity": {"value": 70.4, "unit": "kg"},
                    "category": [{"coding": [{"code": "vital-signs"}]}],
                }
            ]
        }
    )
    csv_text = export.export_observations_csv(fake)
    lines = csv_text.strip().splitlines()
    assert lines[0] == "id,effective,code_system,code,display,value,unit,status,category"
    assert lines[1] == "o1,2026-07-10T08:30:00Z,http://loinc.org,29463-7,Body weight,70.4,kg,final,vital-signs"
