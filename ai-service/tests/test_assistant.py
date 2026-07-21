"""Assistant router invariants against a fake in-memory Medplum: citations are
server-verified (hallucinated [n] tags never reach the client), the boundary
AuditEvent is written BEFORE any cloud call and never for local/unconfigured
routes, session listing/deletion only ever touches assistant-qa Communications
(deletion leaves an audit stub), and NL import creates review Tasks — never
committed clinical resources. No network, no real Medplum."""

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import assistant
from app import fhir_consts as fc
from app.providers import ProviderNotConfigured


class _Resp:
    def __init__(self, status_code: int, body: dict | None = None):
        self.status_code = status_code
        self._body = body or {}
        self.text = json.dumps(self._body)

    def json(self) -> dict:
        return self._body


class FakeMedplum:
    """Captures every write; serves canned search/get results. No live Medplum."""

    def __init__(self, search_results: dict | None = None):
        self.created: list[dict] = []
        self.binaries: list[dict] = []
        self.deleted: list[str] = []
        self.requests: list[dict] = []
        self.search_calls: list[tuple] = []
        self.get_results: dict[str, dict] = {}
        self._search_results = search_results or {}
        self._next_id = 0

    def _new_id(self, prefix: str) -> str:
        self._next_id += 1
        return f"{prefix}-{self._next_id}"

    def search_resources(self, resource_type, params):
        self.search_calls.append((resource_type, dict(params)))
        return [dict(r) for r in self._search_results.get(resource_type, [])]

    def search(self, resource_type, params):
        self.search_calls.append((resource_type, dict(params)))
        return {"total": 0}

    def search_all(self, resource_type, params, max_pages=100):
        # collect_context's window queries — single canned page, never truncated.
        self.search_calls.append((resource_type, dict(params)))
        return [dict(r) for r in self._search_results.get(resource_type, [])], False

    def get(self, path):
        from app.medplum import MedplumError

        if path in self.get_results:
            return dict(self.get_results[path])
        raise MedplumError(f"GET {path}: 404 Not Found")

    def create(self, resource):
        created = {**resource, "id": self._new_id(resource["resourceType"].lower())}
        self.created.append(created)
        return created

    def create_binary(self, data, content_type, security_context=None):
        binary = {"resourceType": "Binary", "id": self._new_id("bin"), "contentType": content_type}
        self.binaries.append(
            {"id": binary["id"], "data": data, "content_type": content_type, "security_context": security_context}
        )
        self.created.append(binary)
        return binary

    def request(self, method, path, **kwargs):
        self.requests.append(
            {"method": method, "path": path, "json": kwargs.get("json"), "headers": kwargs.get("headers", {})}
        )
        if method == "DELETE":
            self.deleted.append(path)
            return _Resp(200)
        if method == "POST":
            return _Resp(201, self.create(kwargs["json"]))
        return _Resp(405)


class FakeProvider:
    endpoint_host = None

    def __init__(self, result, name="anthropic", is_local=False, medplum=None):
        self.result = result
        self.name = name
        self.is_local = is_local
        self.model = "test-model"
        self.calls: list[dict] = []
        self._medplum = medplum
        self.audit_events_at_call: list[dict] | None = None

    def generate_json(self, system, user_content, schema, max_tokens=16000):
        if self._medplum is not None:
            self.audit_events_at_call = [r for r in self._medplum.created if r["resourceType"] == "AuditEvent"]
        self.calls.append({"system": system, "user_content": user_content, "schema": schema})
        return self.result


def _record() -> dict:
    """Small record: one life-critical med, a weight and a symptom observation."""
    return {
        "MedicationRequest": [
            {"resourceType": "Medication", "id": "med-1", "code": {"text": "Metformin"}},
            {
                "resourceType": "MedicationRequest",
                "id": "mr-1",
                "status": "active",
                "medicationReference": {"reference": "Medication/med-1"},
                "dosageInstruction": [{"text": "500 mg twice daily"}],
                "extension": [{"url": fc.EXT_LIFE_CRITICAL, "valueBoolean": True}],
                "authoredOn": "2026-01-05",
            },
        ],
        "Observation": [
            {
                "resourceType": "Observation",
                "id": "obs-w1",
                "status": "final",
                "code": {"coding": [{"system": fc.LOINC, "code": "29463-7", "display": "Body weight"}]},
                "effectiveDateTime": "2026-07-10T08:30:00Z",
                "valueQuantity": {"value": 70.4, "unit": "kg"},
            },
            {
                "resourceType": "Observation",
                "id": "obs-s1",
                "status": "final",
                "code": {"coding": [{"system": fc.CS_OBS, "code": "symptom", "display": "Symptom"}], "text": "Symptom"},
                "effectiveDateTime": "2026-07-12T20:00:00Z",
                "valueString": "mild headache",
            },
        ],
    }


# Context build order: meds first, then observations by sorted label
# ("Body weight" < "Symptom"), so: [1]=mr-1, [2]=obs-w1, [3]=obs-s1.


@pytest.fixture()
def fake(monkeypatch):
    fake = FakeMedplum(_record())
    monkeypatch.setattr(assistant, "medplum", fake)
    monkeypatch.setattr(assistant.settings, "medplum_patient_id", "pat-1")
    return fake


@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(assistant.router)
    return TestClient(app)


def _install_provider(monkeypatch, provider) -> list[str]:
    features: list[str] = []

    def fake_get_provider_for(feature):
        features.append(feature)
        return provider

    monkeypatch.setattr(assistant, "get_provider_for", fake_get_provider_for)
    return features


def _created(fake, resource_type) -> list[dict]:
    return [r for r in fake.created if r["resourceType"] == resource_type]


# --- POST /assistant/ask ---------------------------------------------------------


def test_ask_citations_propagate_and_communication_persisted(client, fake, monkeypatch):
    provider = FakeProvider(
        {
            "answer_markdown": "Latest weight was 70.4 kg on 2026-07-10 [2].",
            "citations": [
                {"n": 2, "resourceType": "Wrong", "id": "bogus", "display": "model lies"},
                {"n": 99, "resourceType": "Observation", "id": "ghost", "display": "hallucinated"},
            ],
            "read_count": 7,
        },
        medplum=fake,
    )
    features = _install_provider(monkeypatch, provider)

    resp = client.post("/assistant/ask", json={"question": "What is my latest weight?"})
    assert resp.status_code == 200
    body = resp.json()
    assert features == ["assistant"]

    # Citations are server-authoritative: [2] resolves to the real Observation,
    # the hallucinated [99] is dropped, model-claimed type/id are overridden.
    assert body["answer_markdown"] == "Latest weight was 70.4 kg on 2026-07-10 [2]."
    assert len(body["citations"]) == 1
    cite = body["citations"][0]
    assert cite["n"] == 2
    assert cite["resourceType"] == "Observation"
    assert cite["id"] == "obs-w1"
    assert cite["value"] == "70.4 kg"
    assert cite["date"] == "2026-07-10"
    assert body["read_count"] == 7
    assert body["provider"] == {"name": "anthropic", "is_local": False}
    assert body["disclaimer"] == fc.DISCLAIMER

    # The context handed to the model carries tagged record elements + the question.
    prompt = provider.calls[0]["user_content"]
    assert "Metformin" in prompt
    assert "LIFE-CRITICAL" in prompt
    assert "[1]" in prompt and "[3]" in prompt
    assert "What is my latest weight?" in prompt
    assert provider.calls[0]["schema"] == assistant.ANSWER_SCHEMA

    # Q&A persisted as a Communication (the assistant's only clinical-adjacent write).
    comms = _created(fake, "Communication")
    assert len(comms) == 1
    comm = comms[0]
    assert comm["category"][0]["coding"][0] == {"system": assistant.CS_COMM, "code": "assistant-qa"}
    assert comm["subject"] == {"reference": "Patient/pat-1"}
    assert comm["payload"][0]["contentString"] == "What is my latest weight?"
    assert comm["payload"][1]["contentString"] == body["answer_markdown"]
    assert body["communication_id"] == comm["id"]

    # READ-ONLY invariant: no other resource types were written.
    assert {r["resourceType"] for r in fake.created} == {"AuditEvent", "Communication"}


def test_ask_cloud_provider_logs_boundary_event_before_call(client, fake, monkeypatch):
    provider = FakeProvider(
        {"answer_markdown": "ok [1].", "citations": [{"n": 1, "resourceType": "x", "id": "y"}], "read_count": 1},
        medplum=fake,
    )
    _install_provider(monkeypatch, provider)
    assert client.post("/assistant/ask", json={"question": "adherence?"}).status_code == 200

    events = _created(fake, "AuditEvent")
    assert len(events) == 1
    assert events[0]["entity"][0]["description"] == "AI request · assistant → anthropic · data left this device"
    # The ledger entry existed before the provider was called.
    assert provider.audit_events_at_call is not None
    assert len(provider.audit_events_at_call) == 1


def test_ask_local_provider_writes_no_boundary_event(client, fake, monkeypatch):
    provider = FakeProvider(
        {"answer_markdown": "ok [1].", "citations": [], "read_count": 0},
        name="ollama",
        is_local=True,
        medplum=fake,
    )
    _install_provider(monkeypatch, provider)
    body = client.post("/assistant/ask", json={"question": "adherence?"}).json()
    assert body["provider"] == {"name": "ollama", "is_local": True}
    assert _created(fake, "AuditEvent") == []  # data never left the device
    assert body["read_count"] == 3  # falls back to the context element count


def test_ask_unconfigured_provider_returns_503_and_writes_nothing(client, fake, monkeypatch):
    def raising(feature):
        raise ProviderNotConfigured("No AI provider configured — pick one in AI Settings")

    monkeypatch.setattr(assistant, "get_provider_for", raising)
    resp = client.post("/assistant/ask", json={"question": "anything?"})
    assert resp.status_code == 503
    assert "No AI provider configured" in resp.json()["detail"]
    assert fake.created == []
    assert fake.search_calls == []  # no record data was even read


def test_ask_validates_question_length(client, fake, monkeypatch):
    _install_provider(monkeypatch, FakeProvider({}))
    assert client.post("/assistant/ask", json={"question": ""}).status_code == 422
    assert client.post("/assistant/ask", json={"question": "x" * 2001}).status_code == 422
    assert client.post("/assistant/ask", json={"question": "   "}).status_code == 400


# --- Sessions ----------------------------------------------------------------------


def test_sessions_lists_newest_first_with_previews(client, fake):
    fake._search_results["Communication"] = [
        {
            "resourceType": "Communication",
            "id": "comm-2",
            "sent": "2026-07-14T10:00:00Z",
            "payload": [{"contentString": "How is my sleep?"}, {"contentString": "A" * 300}],
        },
        {"resourceType": "Communication", "id": "comm-1", "sent": "2026-07-13T09:00:00Z", "payload": []},
    ]
    resp = client.get("/assistant/sessions")
    assert resp.status_code == 200
    items = resp.json()
    assert items[0] == {
        "id": "comm-2",
        "question": "How is my sleep?",
        "answer_preview": "A" * 200,
        "sent": "2026-07-14T10:00:00Z",
    }
    assert items[1]["question"] == ""
    assert fake.search_calls[-1] == (
        "Communication",
        {"category": f"{assistant.CS_COMM}|assistant-qa", "_sort": "-sent", "_count": 50},
    )


def test_delete_session_deletes_and_leaves_audit_stub(client, fake):
    fake.get_results["Communication/comm-1"] = {
        "resourceType": "Communication",
        "id": "comm-1",
        "category": [{"coding": [{"system": assistant.CS_COMM, "code": "assistant-qa"}]}],
    }
    resp = client.delete("/assistant/sessions/comm-1")
    assert resp.status_code == 200
    assert resp.json() == {"id": "comm-1", "deleted": True}
    assert fake.deleted == ["Communication/comm-1"]
    stubs = _created(fake, "AuditEvent")
    assert len(stubs) == 1
    assert stubs[0]["action"] == "D"
    assert stubs[0]["entity"][0] == {"name": "Communication/comm-1", "description": "assistant session deleted"}


def test_delete_session_refuses_non_assistant_communications(client, fake):
    fake.get_results["Communication/other"] = {"resourceType": "Communication", "id": "other", "category": []}
    assert client.delete("/assistant/sessions/other").status_code == 404
    assert client.delete("/assistant/sessions/missing").status_code == 404
    assert fake.deleted == []
    assert fake.created == []


# --- POST /assistant/nl-import -------------------------------------------------------


def _nl_result() -> dict:
    weight = {
        "resourceType": "Observation",
        "status": "final",
        "category": [{"coding": [{"system": assistant.OBS_CATEGORY, "code": "vital-signs"}]}],
        "code": {"coding": [{"system": fc.LOINC, "code": "29463-7", "display": "Body weight"}]},
        "subject": {"reference": "Patient/PATIENT_ID"},
        "effectiveDateTime": "2026-07-15",
        "valueQuantity": {"value": 70.4, "unit": "kg", "system": fc.UCUM, "code": "kg"},
    }
    return {
        "document_kind": "quick note",
        "proposals": [
            {
                "resource_type": "Observation",
                "description": "Body weight 70.4 kg",
                "confidence": 0.92,
                "source_excerpt": "weighed 70.4",
                "resource_json": json.dumps(weight),
            },
            {
                # Disallowed type — must be skipped, never written.
                "resource_type": "Observation",
                "description": "smuggled prescription",
                "confidence": 0.9,
                "resource_json": json.dumps({"resourceType": "MedicationRequest", "status": "active"}),
            },
            {"resource_type": "Observation", "description": "bad json", "confidence": 0.5, "resource_json": "{nope"},
        ],
    }


def test_nl_import_creates_review_tasks_not_committed_resources(client, fake, monkeypatch):
    provider = FakeProvider(_nl_result(), medplum=fake)
    features = _install_provider(monkeypatch, provider)

    resp = client.post("/assistant/nl-import", json={"text": "weighed 70.4 this morning, slept 6h"})
    assert resp.status_code == 200
    body = resp.json()
    assert features == ["nl-import"]
    assert body["proposals"] == 1
    assert len(body["task_ids"]) == 1

    # Review-queue invariant: no clinical resource was committed.
    assert _created(fake, "Observation") == []
    assert _created(fake, "MedicationRequest") == []

    # Raw note stored as Binary + nl-capture DocumentReference. Every Binary
    # holding patient data carries the Patient securityContext (FHIR-MAPPING §6).
    raw = next(b for b in fake.binaries if b["content_type"] == "text/plain")
    assert raw["data"] == b"weighed 70.4 this morning, slept 6h"
    assert all(b["security_context"] == "Patient/pat-1" for b in fake.binaries)
    doc_refs = _created(fake, "DocumentReference")
    assert len(doc_refs) == 1
    assert doc_refs[0]["type"]["coding"][0] == {"system": fc.CS_DOC, "code": "nl-capture"}
    assert doc_refs[0]["content"][0]["attachment"]["url"] == f"Binary/{raw['id']}"
    assert body["document_reference_id"] == doc_refs[0]["id"]

    # Proposal Binary carries the real patient id, never the placeholder.
    proposal_bin = next(b for b in fake.binaries if b["content_type"] == "application/fhir+json")
    assert b"Patient/pat-1" in proposal_bin["data"]
    assert b"PATIENT_ID" not in proposal_bin["data"]

    # Task mirrors ingest.py's review pattern.
    tasks = _created(fake, "Task")
    assert len(tasks) == 1
    task = tasks[0]
    assert task["id"] == body["task_ids"][0]
    assert task["status"] == "requested"
    assert task["intent"] == "proposal"
    assert task["code"]["coding"][0] == {"system": fc.CS_INGEST, "code": "review-ingestion-proposal"}
    assert task["focus"] == {"reference": f"DocumentReference/{doc_refs[0]['id']}"}
    inputs = {i["type"]["coding"][0]["code"]: i for i in task["input"]}
    assert inputs["candidate"]["valueReference"] == {"reference": f"Binary/{proposal_bin['id']}"}
    assert inputs["confidence"]["valueDecimal"] == 0.92
    assert inputs["raw-excerpt"]["valueString"] == "weighed 70.4"

    # Idempotent writes: stable content-hash identifier + If-None-Exist.
    assert task["identifier"][0]["system"] == assistant.NL_IMPORT_IDENT
    task_posts = [r for r in fake.requests if r["method"] == "POST" and r["path"] == "Task"]
    assert task_posts[0]["headers"]["If-None-Exist"] == (
        f"identifier={assistant.NL_IMPORT_IDENT}|{task['identifier'][0]['value']}"
    )

    # Cloud boundary event written before the note left the device.
    assert provider.audit_events_at_call is not None
    assert len(provider.audit_events_at_call) == 1
    assert "nl-import" in _created(fake, "AuditEvent")[0]["entity"][0]["description"]

    # Local time context reaches the model; proposal schema is ingest's.
    from app.ingest import PROPOSAL_SCHEMA

    assert provider.calls[0]["schema"] == PROPOSAL_SCHEMA
    assert "Current local time" in provider.calls[0]["user_content"]


def test_nl_import_with_no_structurable_data(client, fake, monkeypatch):
    provider = FakeProvider({"document_kind": "note", "proposals": []}, name="ollama", is_local=True, medplum=fake)
    _install_provider(monkeypatch, provider)
    body = client.post("/assistant/nl-import", json={"text": "hello there"}).json()
    assert body == {"proposals": 0, "task_ids": [], "note": "No structurable data found in the note."}
    assert fake.created == []  # local provider + nothing to propose → zero writes


def test_nl_import_unconfigured_provider_returns_503_and_writes_nothing(client, fake, monkeypatch):
    def raising(feature):
        raise ProviderNotConfigured("AI is turned off for 'nl-import' — enable it in AI Settings")

    monkeypatch.setattr(assistant, "get_provider_for", raising)
    resp = client.post("/assistant/nl-import", json={"text": "weighed 70.4"})
    assert resp.status_code == 503
    assert fake.created == []
    assert fake.binaries == []


# --- POST /assistant/parse-feeling ---------------------------------------------------


def _feeling_result(**overrides) -> dict:
    result = {
        "mood": 3,
        "energy": 5,
        "tags": ["headache", "tired", "dizziness"],
        "note": "Feeling terrible, maybe a three. Headache and pretty tired, energy about a five.",
        "confidence": "high",
    }
    result.update(overrides)
    return result


def test_parse_feeling_happy_path_cloud(client, fake, monkeypatch):
    provider = FakeProvider(_feeling_result(), medplum=fake)
    features = _install_provider(monkeypatch, provider)

    transcript = "um, feeling terrible, maybe a three. headache and pretty tired, energy about a five"
    resp = client.post("/assistant/parse-feeling", json={"transcript": transcript})
    assert resp.status_code == 200
    body = resp.json()
    assert features == ["feeling"]
    assert body["mood"] == 3
    assert body["energy"] == 5
    # "dizziness" is nowhere in the transcript → server-side grounding drops it
    # (invented tags never reach the confirmation screen).
    assert body["tags"] == ["headache", "tired"]
    assert body["note"] == "Feeling terrible, maybe a three. Headache and pretty tired, energy about a five."
    assert body["provider"] == "anthropic"
    assert body["model"] == "test-model"
    assert body["confidence"] == "high"

    # Boundary AuditEvent written BEFORE the transcript left the device,
    # standard ledger coding + description format.
    assert provider.audit_events_at_call is not None
    assert len(provider.audit_events_at_call) == 1
    events = _created(fake, "AuditEvent")
    assert len(events) == 1
    assert events[0]["type"]["code"] == "cloud-egress"
    assert events[0]["subtype"] == [{"system": fc.CS_AUDIT, "code": "feeling"}]
    assert events[0]["entity"][0]["description"] == "AI request · feeling → anthropic · data left this device"

    # Parse-only endpoint: no clinical resource is ever written here — the
    # client confirms on screen and performs the Observation writes itself.
    assert {r["resourceType"] for r in fake.created} == {"AuditEvent"}
    assert fake.binaries == []

    # The transcript reached the model with the feeling schema.
    assert transcript in provider.calls[0]["user_content"]
    assert provider.calls[0]["schema"] == assistant.FEELING_SCHEMA


def test_parse_feeling_null_values_local_provider(client, fake, monkeypatch):
    provider = FakeProvider(
        _feeling_result(mood=None, energy=None, tags=[], note="Just checking in.", confidence="low"),
        name="ollama",
        is_local=True,
        medplum=fake,
    )
    _install_provider(monkeypatch, provider)
    resp = client.post("/assistant/parse-feeling", json={"transcript": "just checking in"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["mood"] is None
    assert body["energy"] is None
    assert body["tags"] == []
    assert body["note"] == "Just checking in."
    assert body["provider"] == "ollama"
    assert body["confidence"] == "low"
    assert fake.created == []  # local route: no boundary event, no writes at all


def test_parse_feeling_clamps_and_coerces(client, fake, monkeypatch):
    # Out-of-scale ints clamp into 1-10; an absent/empty note falls back to the
    # raw transcript; an unknown confidence degrades to "low".
    provider = FakeProvider(
        _feeling_result(mood=15, energy=0, tags=["tired"], note="", confidence="banana"),
        name="ollama",
        is_local=True,
        medplum=fake,
    )
    _install_provider(monkeypatch, provider)
    body = client.post("/assistant/parse-feeling", json={"transcript": "so tired"}).json()
    assert body["mood"] == 10
    assert body["energy"] == 1
    assert body["note"] == "so tired"
    assert body["confidence"] == "low"

    # Numeric strings/floats round then clamp; non-numeric junk → null, never a guess.
    provider = FakeProvider(
        _feeling_result(mood="7.6", energy="unknown", tags=[]), name="ollama", is_local=True, medplum=fake
    )
    _install_provider(monkeypatch, provider)
    body = client.post("/assistant/parse-feeling", json={"transcript": "mood seven point six ish"}).json()
    assert body["mood"] == 8
    assert body["energy"] is None


def test_parse_feeling_validates_transcript(client, fake, monkeypatch):
    _install_provider(monkeypatch, FakeProvider({}))
    assert client.post("/assistant/parse-feeling", json={"transcript": ""}).status_code == 422
    assert client.post("/assistant/parse-feeling", json={"transcript": "x" * 2001}).status_code == 422
    assert client.post("/assistant/parse-feeling", json={"transcript": "   "}).status_code == 400
    assert fake.created == []


def test_parse_feeling_routing_off_via_real_ai_settings(client, fake, monkeypatch, tmp_path):
    # Exercise the real routing path: "feeling" is a first-class FEATURES entry,
    # and routing it off yields the standard 503 "configure a provider" signal.
    from app import ai_settings

    monkeypatch.setattr(ai_settings, "SETTINGS_FILE", tmp_path / "ai-settings.json")
    monkeypatch.setattr(ai_settings.settings, "ai_provider", "")
    ai_settings._save({"routing": {"feeling": "off"}, "cloud_provider": "anthropic", "models": {}, "base_urls": {}})
    resp = client.post("/assistant/parse-feeling", json={"transcript": "feeling fine"})
    assert resp.status_code == 503
    assert "turned off" in resp.json()["detail"]
    assert fake.created == []  # nothing written, nothing sent


def test_parse_feeling_no_provider_configured_returns_503(client, fake, monkeypatch, tmp_path):
    from app import ai_settings

    monkeypatch.setattr(ai_settings, "SETTINGS_FILE", tmp_path / "ai-settings.json")
    monkeypatch.setattr(ai_settings.settings, "ai_provider", "")
    ai_settings._save({"routing": {"feeling": "cloud"}, "cloud_provider": None, "models": {}, "base_urls": {}})
    resp = client.post("/assistant/parse-feeling", json={"transcript": "feeling fine"})
    assert resp.status_code == 503
    assert "No AI provider configured" in resp.json()["detail"]
    assert fake.created == []
