"""MedplumFhirClient helpers added for the review-gate / takeout fixes:
`search_all` follows Bundle.link.next (rebasing the server-advertised URL onto
our own base) and reports truncation instead of hiding it; `validate_resource`
turns $validate error issues into a user-correctable ValueError while keeping
transport failures as MedplumError; `create_binary` sends X-Security-Context
so Binary.securityContext is set on raw-bytes uploads. All HTTP is faked at
the `request` layer — no live Medplum."""

import httpx
import pytest

from app.medplum import MedplumError, MedplumFhirClient


def _client_with(responder):
    """A real client whose `request` is replaced by `responder(method, path, **kw)`;
    every call is recorded on client.calls."""
    client = MedplumFhirClient()
    client.calls = []

    def fake_request(method, path, **kwargs):
        client.calls.append({"method": method, "path": path, **kwargs})
        return responder(method, path, **kwargs)

    client.request = fake_request
    return client


def _bundle(resources, next_url=None):
    bundle = {"resourceType": "Bundle", "type": "searchset", "entry": [{"resource": r} for r in resources]}
    if next_url:
        bundle["link"] = [{"relation": "next", "url": next_url}]
    return bundle


# --- search_all -------------------------------------------------------------------


def test_search_all_follows_next_links_and_rebases_host():
    pages = [
        _bundle([{"id": "a"}, {"id": "b"}], next_url="http://public-host:8103/fhir/R4/Observation?_offset=2"),
        _bundle([{"id": "c"}], next_url="http://public-host:8103/fhir/R4/Observation?_offset=3"),
        _bundle([{"id": "d"}]),  # no next link — done
    ]
    client = _client_with(lambda m, p, **kw: httpx.Response(200, json=pages[len(client.calls) - 1]))

    resources, truncated = client.search_all("Observation", {"_count": 2})
    assert [r["id"] for r in resources] == ["a", "b", "c", "d"]
    assert truncated is False
    # The next link's public host was rebased onto our configured FHIR base
    # (same class of problem as read_attachment's presigned URLs).
    assert client.calls[1]["path"] == "Observation?_offset=2"
    assert client.calls[2]["path"] == "Observation?_offset=3"


def test_search_all_reports_truncation_at_max_pages():
    always_more = _bundle([{"id": "x"}], next_url="http://h/fhir/R4/Observation?_offset=1")
    client = _client_with(lambda m, p, **kw: httpx.Response(200, json=always_more))

    resources, truncated = client.search_all("Observation", {}, max_pages=3)
    assert len(resources) == 3  # one per fetched page, then the ceiling
    assert truncated is True
    assert len(client.calls) == 3


def test_search_all_single_page():
    client = _client_with(lambda m, p, **kw: httpx.Response(200, json=_bundle([{"id": "only"}])))
    resources, truncated = client.search_all("Task", {"status": "requested"})
    assert [r["id"] for r in resources] == ["only"]
    assert truncated is False
    assert client.calls[0]["params"] == {"status": "requested"}


# --- validate_resource ------------------------------------------------------------


def _outcome(*issues):
    return {"resourceType": "OperationOutcome", "issue": list(issues)}


def test_validate_resource_ok_returns_issues():
    ok = _outcome({"severity": "information", "code": "informational", "details": {"text": "All OK"}})
    client = _client_with(lambda m, p, **kw: httpx.Response(200, json=ok))
    issues = client.validate_resource({"resourceType": "Observation", "status": "final"})
    assert issues[0]["details"]["text"] == "All OK"
    assert client.calls[0]["method"] == "POST"
    assert client.calls[0]["path"] == "Observation/$validate"


def test_validate_resource_error_issues_raise_value_error():
    bad = _outcome(
        {"severity": "error", "details": {"text": "Invalid additional property"}, "expression": ["Observation.bogus"]},
        {"severity": "error", "diagnostics": "Missing required property status"},
    )
    client = _client_with(lambda m, p, **kw: httpx.Response(400, json=bad))
    with pytest.raises(ValueError, match="failed FHIR validation") as exc:
        client.validate_resource({"resourceType": "Observation", "bogus": True})
    # Issues are summarized for the Review page so the owner can correct them.
    assert "Invalid additional property" in str(exc.value)
    assert "Observation.bogus" in str(exc.value)
    assert "Missing required property status" in str(exc.value)


def test_validate_resource_error_issues_with_200_still_raise():
    bad = _outcome({"severity": "fatal", "details": {"text": "structure failure"}})
    client = _client_with(lambda m, p, **kw: httpx.Response(200, json=bad))
    with pytest.raises(ValueError, match="structure failure"):
        client.validate_resource({"resourceType": "Condition"})


def test_validate_resource_transport_failure_is_medplum_error():
    client = _client_with(lambda m, p, **kw: httpx.Response(500, text="boom"))
    with pytest.raises(MedplumError, match=r"\$validate"):
        client.validate_resource({"resourceType": "Observation"})


def test_validate_resource_requires_resource_type():
    client = _client_with(lambda m, p, **kw: httpx.Response(200, json={}))
    with pytest.raises(ValueError, match="no resourceType"):
        client.validate_resource({"status": "final"})
    assert client.calls == []  # nothing was sent


# --- create_binary securityContext --------------------------------------------------


def test_create_binary_sends_security_context_header():
    client = _client_with(lambda m, p, **kw: httpx.Response(201, json={"resourceType": "Binary", "id": "b1"}))
    client.create_binary(b"pdf-bytes", "application/pdf", security_context="Patient/p1")
    call = client.calls[0]
    assert call["path"] == "Binary"
    assert call["headers"]["Content-Type"] == "application/pdf"
    assert call["headers"]["X-Security-Context"] == "Patient/p1"


def test_create_binary_without_security_context_omits_header():
    client = _client_with(lambda m, p, **kw: httpx.Response(201, json={"resourceType": "Binary", "id": "b1"}))
    client.create_binary(b"x", "text/plain")
    assert "X-Security-Context" not in client.calls[0]["headers"]
