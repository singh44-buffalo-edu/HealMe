"""Health Review context collection: window queries paginate via
medplum.search_all with the documented CONTEXT_MAX_PAGES ceiling, and a
truncated window is disclosed in the context (and the no-AI data summary)
instead of silently reporting on partial data. Plus: stored review Binaries
carry the Patient securityContext. Fake in-memory Medplum — no network."""

from app import health_review


class FakeMedplum:
    def __init__(self, search_all_results=None, truncated_types=()):
        self._search_all = search_all_results or {}
        self._truncated = set(truncated_types)
        self.search_all_calls = []
        self.binaries = []
        self.created = []

    def search_resources(self, resource_type, params):
        return []

    def search(self, resource_type, params):
        return {"total": 0}

    def search_all(self, resource_type, params, max_pages=100):
        self.search_all_calls.append({"type": resource_type, "params": dict(params), "max_pages": max_pages})
        return list(self._search_all.get(resource_type, [])), resource_type in self._truncated

    def create_binary(self, data, content_type, security_context=None):
        binary = {"resourceType": "Binary", "id": f"bin-{len(self.binaries) + 1}"}
        self.binaries.append({"content_type": content_type, "security_context": security_context})
        return binary

    def create(self, resource):
        created = {**resource, "id": "doc-1"}
        self.created.append(created)
        return created


def test_collect_context_paginates_with_ceiling_and_no_flag_when_complete():
    fake = FakeMedplum()
    context = health_review.collect_context(fake, 90)
    assert "window_truncated" not in context
    # Both window queries went through the next-link helper, newest-first so
    # any residual truncation clips the oldest edge, under the documented ceiling.
    by_type = {c["type"]: c for c in fake.search_all_calls}
    assert by_type["MedicationAdministration"]["params"]["_sort"] == "-effective-time"
    assert by_type["Observation"]["params"]["_sort"] == "-date"
    assert all(c["max_pages"] == health_review.CONTEXT_MAX_PAGES for c in fake.search_all_calls)


def test_collect_context_discloses_truncated_window_in_summary():
    fake = FakeMedplum(truncated_types={"Observation"})
    context = health_review.collect_context(fake, 3650)
    assert "Data gap" in context["window_truncated"]
    # The no-AI clinician summary prints the disclosure verbatim.
    summary = health_review.build_data_summary(context)
    assert context["window_truncated"] in summary


def test_store_review_binaries_carry_patient_security_context():
    fake = FakeMedplum()
    result = health_review._store_review(
        fake,
        "# Health Review\n\nAll good.",
        {"generated_at": "2026-07-15T00:00:00+00:00"},
        90,
        "p1",
        "AI Health Review — last 90 days",
    )
    assert result["document_reference_id"] == "doc-1"
    assert [b["content_type"] for b in fake.binaries] == ["text/markdown", "application/pdf"]
    assert all(b["security_context"] == "Patient/p1" for b in fake.binaries)
