"""Review-queue approval gate (ingest.approve_task): the resolved candidate
must pass server-side $validate BEFORE the commit transaction is assembled —
a validation failure raises ValueError (→ 400) with the Task untouched (still
'requested', correct-and-retry), because Medplum transactions are not
all-or-nothing and an invalid entry could otherwise complete the Task while
the resource itself fails. Plus: patient-data Binaries created by the
ingestion pipeline carry the Patient securityContext. Everything runs against
a fake in-memory Medplum — no network."""

import json

import pytest

from app import fhir_consts as fc
from app import ingest
from app.providers import ProviderNotConfigured


class FakeMedplum:
    """Canned Task/candidate reads; records validate/bundle/update/binary calls."""

    def __init__(self, task=None, candidate=None, validate_error=None):
        self.task = task
        self.candidate = candidate
        self.validate_error = validate_error
        self.validated = []
        self.bundles = []
        self.updated = []
        self.created = []
        self.binaries = []

    def get(self, path):
        assert path == f"Task/{self.task['id']}"
        return dict(self.task)

    def read_binary(self, binary_id):
        assert binary_id == "bin-1"
        return json.dumps(self.candidate).encode()

    def validate_resource(self, resource):
        self.validated.append(json.loads(json.dumps(resource)))
        if self.validate_error:
            raise ValueError(self.validate_error)
        return []

    def post_bundle(self, bundle):
        self.bundles.append(bundle)
        return {
            "entry": [
                {"response": {"status": "201", "location": "Observation/new-1"}},
                {"response": {"status": "201"}},
                {"response": {"status": "200"}},
            ]
        }

    def update(self, resource):
        self.updated.append(resource)
        return resource

    def create(self, resource):
        created = {**resource, "id": f"{resource['resourceType'].lower()}-{len(self.created) + 1}"}
        self.created.append(created)
        return created

    def create_binary(self, data, content_type, security_context=None):
        binary = {"resourceType": "Binary", "id": f"bin-{len(self.binaries) + 1}"}
        self.binaries.append({"data": data, "content_type": content_type, "security_context": security_context})
        return binary


def _task(status="requested"):
    return {
        "resourceType": "Task",
        "id": "task-1",
        "status": status,
        "intent": "proposal",
        "focus": {"reference": "DocumentReference/doc-1"},
        "input": [
            {
                "type": {"coding": [{"system": fc.CS_INGEST, "code": "candidate"}]},
                "valueReference": {"reference": "Binary/bin-1"},
            },
            {"type": {"coding": [{"system": fc.CS_INGEST, "code": "confidence"}]}, "valueDecimal": 0.9},
        ],
    }


def _candidate():
    return {
        "resourceType": "Observation",
        "status": "final",
        "code": {"text": "Hemoglobin"},
        "subject": {"reference": "Patient/p1"},
        "valueQuantity": {"value": 13.5, "unit": "g/dL"},
    }


# --- approve_task: the $validate gate ------------------------------------------------


def test_approve_validates_the_exact_committed_resource_then_commits():
    fake = FakeMedplum(task=_task(), candidate=_candidate())
    result = ingest.approve_task(fake, "task-1", None)
    assert result == {"committed": "Observation/new-1", "task_id": "task-1"}

    # $validate saw the resource exactly as committed — commit identifier included.
    assert len(fake.validated) == 1
    validated = fake.validated[0]
    assert validated["resourceType"] == "Observation"
    assert {"system": f"{fc.IDENT}/ingestion", "value": "task-task-1"} in validated["identifier"]
    assert validated == fake.bundles[0]["entry"][0]["resource"]

    # Normal three-entry transaction: resource + Provenance + Task completed.
    bundle = fake.bundles[0]
    assert [e["request"]["method"] for e in bundle["entry"]] == ["POST", "POST", "PUT"]
    assert bundle["entry"][2]["resource"]["status"] == "completed"


def test_approve_validation_failure_raises_400_and_leaves_task_requested():
    fake = FakeMedplum(
        task=_task(),
        candidate={**_candidate(), "bogus": True},
        validate_error="Observation failed FHIR validation: Invalid additional property (at Observation.bogus)",
    )
    with pytest.raises(ValueError, match="Invalid additional property"):
        ingest.approve_task(fake, "task-1", None)

    # The gate fired before ANY write: no transaction, no Task flip — the
    # proposal stays in the review queue for the owner to correct and re-approve.
    assert fake.validated  # $validate ran
    assert fake.bundles == []
    assert fake.updated == []


def test_approve_validates_owner_corrected_resource():
    fake = FakeMedplum(task=_task(), candidate=_candidate())
    corrected = {**_candidate(), "valueQuantity": {"value": 14.1, "unit": "g/dL"}}
    ingest.approve_task(fake, "task-1", corrected)
    assert fake.validated[0]["valueQuantity"]["value"] == 14.1


def test_approve_rejects_non_requested_task_before_validation():
    fake = FakeMedplum(task=_task(status="completed"), candidate=_candidate())
    with pytest.raises(ValueError, match="expected 'requested'"):
        ingest.approve_task(fake, "task-1", None)
    assert fake.validated == []
    assert fake.bundles == []


def test_approve_rejects_disallowed_resource_type_before_validation():
    fake = FakeMedplum(task=_task(), candidate=_candidate())
    smuggled = {"resourceType": "MedicationRequest", "status": "active"}
    with pytest.raises(ValueError, match="no valid candidate"):
        ingest.approve_task(fake, "task-1", smuggled)
    assert fake.validated == []
    assert fake.bundles == []


# --- ingest_document: Binary securityContext ------------------------------------------


def test_ingest_document_sets_patient_security_context(monkeypatch):
    def raising():
        raise ProviderNotConfigured("no provider")

    monkeypatch.setattr(ingest, "get_provider", raising)
    fake = FakeMedplum()
    result = ingest.ingest_document(fake, b"not really a pdf", "application/pdf", "labs.pdf", "p1")

    # Document stored even with no AI provider; the original Binary carries the
    # Patient securityContext (FHIR-MAPPING §6).
    assert result["proposals_created"] == 0
    assert fake.binaries[0]["security_context"] == "Patient/p1"
    doc_ref = fake.created[0]
    assert doc_ref["resourceType"] == "DocumentReference"
    assert doc_ref["subject"] == {"reference": "Patient/p1"}
