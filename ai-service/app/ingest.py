"""Document ingestion with the human review gate (FHIR-MAPPING §6).

Pipeline: upload a PDF/photo → original stored immutably (Binary +
DocumentReference) → extract text (pypdf, OCR fallback) → AI proposes FHIR
resources → each proposal becomes a Task + proposal Binary in the review
queue. Nothing is committed as a clinical resource until the owner approves
(server-side $validate, then one transaction: resource + Provenance + Task
completed). AI/OCR never bypasses this gate — the central medical-safety
invariant of ingestion.

Proposal Task shape (FHIR-MAPPING §6, shared verbatim with assistant.py's
NL capture — the frontend Review page reads both identically):

    Task.status  = requested → completed | rejected
    Task.intent  = proposal
    Task.code    = local `review-ingestion-proposal`
    Task.for     → Patient, Task.focus → source DocumentReference
    Task.input   = candidate (proposal Binary ref) + confidence (decimal)
                   + raw-excerpt (source quote, when useful)
    Task.output  = final-resource (committed Resource ref, set on approval)

Called by main.py (/ingest/*) and watcher.py (inbox documents); calls the
provider layer for extraction and medplum for all CDR I/O.
"""

from __future__ import annotations

import base64
import io
import json
import uuid
from datetime import datetime, timezone
from typing import Any

from . import fhir_consts as fc
from .medplum import MedplumFhirClient
from .providers import ProviderNotConfigured, get_provider

# Upload types the pipeline accepts (MVP slice: PDFs/photos — owner decision,
# CLAUDE.md §8; structured formats go through importers.py instead).
ALLOWED_TYPES = {
    "application/pdf": "pdf",
    "image/png": "image",
    "image/jpeg": "image",
}

# Resource types a proposal may commit as. Deliberately excludes
# MedicationRequest (historical meds become MedicationStatement — an extraction
# must never create an active prescription) and anything device/schedule-shaped.
# assistant.py's NL capture imports and enforces this same list.
ALLOWED_RESOURCE_TYPES = [
    "Observation",
    "Condition",
    "MedicationStatement",
    "AllergyIntolerance",
    "Immunization",
    "Procedure",
    "DiagnosticReport",
]

EXTRACTION_SYSTEM = f"""You extract structured clinical data from a person's own medical document
for their personal FHIR R4 health record. Rules:

- Propose only what the document actually states. Never invent values, dates, codes, or diagnoses.
- Allowed resource types: {", ".join(ALLOWED_RESOURCE_TYPES)}.
- Every proposed resource must be valid FHIR R4 JSON with "resourceType" and
  "subject"/"patient" set to {{"reference": "Patient/PATIENT_ID"}} (literally PATIENT_ID —
  it is substituted later).
- Lab values: Observation with category laboratory, valueQuantity with the original unit,
  referenceRange when the report states it, effectiveDateTime from the report.
- Use LOINC codes ONLY when certain; otherwise use {{"text": "<original label>"}} without coding.
  Never guess codes.
- Keep original wording in code.text / note fields. Dates as YYYY-MM-DD when known.
- confidence is your honest 0-1 estimate that the extraction is faithful to the document.
- Historical medications become MedicationStatement (never MedicationRequest).
"""

# Structured-output schema for extraction AND NL capture (assistant.py imports
# it): resource_json is a string (not an object) so providers with shallow
# schema support can still emit arbitrary FHIR resources inside it.
PROPOSAL_SCHEMA = {
    "type": "object",
    "properties": {
        "document_kind": {"type": "string", "description": "e.g. lab report, prescription, discharge summary"},
        "proposals": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "resource_type": {"type": "string", "enum": ALLOWED_RESOURCE_TYPES},
                    "description": {"type": "string", "description": "one-line human summary of the proposal"},
                    "confidence": {"type": "number"},
                    "source_excerpt": {"type": "string", "description": "short quote from the document"},
                    "resource_json": {"type": "string", "description": "the FHIR resource as a JSON string"},
                },
                "required": ["resource_type", "description", "confidence", "resource_json"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["document_kind", "proposals"],
    "additionalProperties": False,
}


def extract_text(data: bytes, content_type: str) -> tuple[str, str]:
    """Returns (text, method). OCR fallback for scanned PDFs and images.
    Never raises: extraction failure returns ("", "failed") — the document is
    already stored, and the AI layer can still see it via the vision fallback."""
    try:
        if content_type == "application/pdf":
            from pypdf import PdfReader

            reader = PdfReader(io.BytesIO(data))
            pages = [page.extract_text() or "" for page in reader.pages]
            text = "\n\n".join(pages).strip()
            # A real text layer averages far more than 100 chars per page —
            # below that treat it as scanned and OCR.
            if pages and len(text) / len(pages) >= 100:
                return text, "pdf-text"
            import pytesseract
            from pdf2image import convert_from_bytes

            images = convert_from_bytes(data, dpi=200)
            ocr = "\n\n".join(pytesseract.image_to_string(img) for img in images)
            return ocr.strip(), "ocr"
        # Photo
        import pytesseract
        from PIL import Image

        return pytesseract.image_to_string(Image.open(io.BytesIO(data))).strip(), "ocr"
    except Exception:  # noqa: BLE001 — missing OCR deps / corrupt file must not fail the upload
        return "", "failed"


def _document_content_blocks(data: bytes, content_type: str, text: str) -> str | list[dict[str, Any]]:
    """Prefer extracted text; fall back to sending the document itself to a
    vision-capable model when local extraction found nearly nothing."""
    if len(text) > 200:
        return f"Document text:\n\n{text[:60000]}"
    encoded = base64.standard_b64encode(data).decode()
    block_type = "document" if content_type == "application/pdf" else "image"
    return [
        {"type": block_type, "source": {"type": "base64", "media_type": content_type, "data": encoded}},
        {"type": "text", "text": "Extract clinical data from this document."},
    ]


def ingest_document(
    medplum: MedplumFhirClient, data: bytes, content_type: str, filename: str, patient_id: str
) -> dict[str, Any]:
    """Run the full upload pipeline for one document; returns a summary dict
    (document id, extraction method, proposal count). FHIR: creates Binary +
    DocumentReference always, then a proposal Binary + Task per accepted
    candidate. Degrades gracefully: with no AI provider the document is still
    stored (proposals_created=0 + a note) — storage never depends on AI."""
    if content_type not in ALLOWED_TYPES:
        raise ValueError(f"unsupported type {content_type} — PDF, PNG or JPEG only")

    # The immutable original, stored before anything can fail downstream
    # (FHIR-MAPPING §6: extraction output never overwrites the source).
    # securityContext ties the Binary's access to the Patient (§6 mandate).
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    binary = medplum.create_binary(data, content_type, security_context=f"Patient/{patient_id}")
    doc_ref = medplum.create(
        {
            "resourceType": "DocumentReference",
            "status": "current",
            "type": {"coding": [{"system": fc.CS_DOC, "code": "uploaded-document"}], "text": "Uploaded document"},
            "subject": {"reference": f"Patient/{patient_id}"},
            "date": now,
            "description": filename,
            "content": [
                {"attachment": {"url": f"Binary/{binary['id']}", "contentType": content_type, "title": filename}}
            ],
        }
    )

    text, method = extract_text(data, content_type)

    try:
        provider = get_provider()
    except ProviderNotConfigured as err:
        return {
            "document_reference_id": doc_ref["id"],
            "extraction_method": method,
            "text_chars": len(text),
            "proposals_created": 0,
            "note": f"Document stored. No extraction proposals: {err}",
        }

    result = provider.generate_json(
        EXTRACTION_SYSTEM, _document_content_blocks(data, content_type, text), PROPOSAL_SCHEMA
    )

    # One review Task per surviving candidate. Server-side re-validation of the
    # resource type: the schema enum is advisory, this check is authoritative.
    # Deliberately NO $validate here (or in assistant.py's NL capture): a
    # malformed proposal should still reach the queue so the owner can correct
    # it there; approve_task's $validate is the single gate before commit.
    created = 0
    for proposal in result.get("proposals", []):
        try:
            resource = json.loads(proposal["resource_json"])
        except (json.JSONDecodeError, TypeError, KeyError):
            continue
        if resource.get("resourceType") not in ALLOWED_RESOURCE_TYPES:
            continue
        # substitute the real patient id
        payload = json.dumps(resource).replace("PATIENT_ID", patient_id)
        proposal_binary = medplum.create_binary(
            payload.encode(), "application/fhir+json", security_context=f"Patient/{patient_id}"
        )
        task_input = [
            {
                "type": {"coding": [{"system": fc.CS_INGEST, "code": "candidate"}]},
                "valueReference": {"reference": f"Binary/{proposal_binary['id']}"},
            },
            {
                "type": {"coding": [{"system": fc.CS_INGEST, "code": "confidence"}]},
                "valueDecimal": max(0.0, min(1.0, float(proposal.get("confidence", 0)))),
            },
        ]
        if proposal.get("source_excerpt"):
            task_input.append(
                {
                    "type": {"coding": [{"system": fc.CS_INGEST, "code": "raw-excerpt"}]},
                    "valueString": str(proposal["source_excerpt"])[:1000],
                }
            )
        medplum.create(
            {
                "resourceType": "Task",
                "status": "requested",
                "intent": "proposal",
                "code": {"coding": [{"system": fc.CS_INGEST, "code": "review-ingestion-proposal"}]},
                "description": proposal.get("description", "Proposed extraction"),
                "for": {"reference": f"Patient/{patient_id}"},
                "focus": {"reference": f"DocumentReference/{doc_ref['id']}"},
                "authoredOn": now,
                "input": task_input,
            }
        )
        created += 1

    return {
        "document_reference_id": doc_ref["id"],
        "document_kind": result.get("document_kind", "unknown"),
        "extraction_method": method,
        "text_chars": len(text),
        "proposals_created": created,
    }


def list_review_tasks(medplum: MedplumFhirClient) -> list[dict[str, Any]]:
    """Pending proposals for the Review page: status=requested Tasks with their
    Task.input decoded (candidate resource fetched from its proposal Binary,
    confidence, excerpt). A corrupt candidate payload yields resource=None
    rather than hiding the task — the owner can still reject it."""
    tasks = medplum.search_resources(
        "Task",
        {
            "status": "requested",
            "code": f"{fc.CS_INGEST}|review-ingestion-proposal",
            "_sort": "-_lastUpdated",
            "_count": 100,
        },
    )
    out = []
    for task in tasks:
        candidate_ref = confidence = excerpt = None
        for item in task.get("input", []):
            code = (item.get("type", {}).get("coding") or [{}])[0].get("code")
            if code == "candidate":
                candidate_ref = item.get("valueReference", {}).get("reference")
            elif code == "confidence":
                confidence = item.get("valueDecimal")
            elif code == "raw-excerpt":
                excerpt = item.get("valueString")
        resource = None
        if candidate_ref:
            try:
                resource = json.loads(medplum.read_binary(candidate_ref.split("/")[-1]).decode())
            except Exception:  # noqa: BLE001 — a broken payload should not hide the task
                resource = None
        out.append(
            {
                "task_id": task["id"],
                "description": task.get("description", ""),
                "confidence": confidence,
                "source_excerpt": excerpt,
                "document_reference": task.get("focus", {}).get("reference"),
                "authored_on": task.get("authoredOn"),
                "resource": resource,
            }
        )
    return out


def approve_task(medplum: MedplumFhirClient, task_id: str, corrected_resource: dict[str, Any] | None) -> dict[str, Any]:
    """Owner approval — the ONLY path from proposal to clinical resource.
    `corrected_resource` (when given) is the owner's edited version and
    replaces the stored candidate; it is re-validated against
    ALLOWED_RESOURCE_TYPES. The resolved resource must then pass the server's
    $validate before anything is assembled — a validation failure raises
    ValueError (→ HTTP 400) and the Task stays 'requested', so the owner can
    correct and re-approve instead of the proposal vanishing (Medplum
    transactions are not all-or-nothing: an invalid entry could otherwise
    flip the Task to completed while the resource itself 400s, CLAUDE.md §9).
    Commits atomically per FHIR-MAPPING §6: create resource + create
    Provenance (naming the source document and confidence) + flip the Task to
    completed, in one transaction Bundle. Retry-safe via the task-scoped
    identifier (see inline note)."""
    task = medplum.get(f"Task/{task_id}")
    if task.get("status") != "requested":
        # Double-click / stale-tab guard: an already-completed or rejected
        # proposal can never be committed twice.
        raise ValueError(f"task is {task.get('status')}, expected 'requested'")

    # Resolve the resource to commit: owner correction wins, otherwise the
    # stored candidate payload from the proposal Binary.
    resource = corrected_resource
    if resource is None:
        for item in task.get("input", []):
            code = (item.get("type", {}).get("coding") or [{}])[0].get("code")
            if code == "candidate":
                ref = item["valueReference"]["reference"]
                resource = json.loads(medplum.read_binary(ref.split("/")[-1]).decode())
    if not resource or resource.get("resourceType") not in ALLOWED_RESOURCE_TYPES:
        raise ValueError("no valid candidate resource on this task")

    confidence = next(
        (
            item.get("valueDecimal")
            for item in task.get("input", [])
            if (item.get("type", {}).get("coding") or [{}])[0].get("code") == "confidence"
        ),
        None,
    )
    source_doc = task.get("focus", {}).get("reference")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    resource_urn = f"urn:uuid:{uuid.uuid4()}"

    # Stable business identifier makes the commit retry-safe: Medplum can
    # partially commit a transaction whose later entries fail (see CLAUDE.md),
    # so a retry must find the already-created resource instead of duplicating.
    commit_ident = {"system": f"{fc.IDENT}/ingestion", "value": f"task-{task_id}"}
    resource.setdefault("identifier", [])
    if not any(
        i.get("system") == commit_ident["system"] and i.get("value") == commit_ident["value"]
        for i in resource["identifier"]
    ):
        resource["identifier"].append(commit_ident)

    # $validate gate — the ONLY validation point of the proposal pipeline
    # (creation deliberately skips it, see ingest_document). Validates the
    # exact resource that will be committed (identifier included); raises
    # ValueError with the OperationOutcome issues summarized, BEFORE the
    # transaction exists, so a bad proposal can never half-commit.
    medplum.validate_resource(resource)

    # Assemble the three-entry transaction: resource (conditional create),
    # Provenance targeting it via urn:uuid, Task completion with the output
    # reference — all-or-nothing under normal operation, and safe to retry
    # because entry 1 is conditional (see post_bundle's partial-commit note).
    task_done = {
        **task,
        "status": "completed",
        "lastModified": now,
        "output": [
            {
                "type": {"coding": [{"system": fc.CS_INGEST, "code": "final-resource"}]},
                "valueReference": {"reference": resource_urn},
            }
        ],
    }
    provenance = {
        "resourceType": "Provenance",
        "target": [{"reference": resource_urn}],
        "recorded": now,
        "agent": [
            {
                "type": {"text": f"HealMeDaily ingestion pipeline (confidence {confidence})"},
                "who": {"display": "HealMeDaily AI ingestion service"},
            }
        ],
    }
    if source_doc:
        provenance["entity"] = [{"role": "source", "what": {"reference": source_doc}}]
    bundle = {
        "resourceType": "Bundle",
        "type": "transaction",
        "entry": [
            {
                "fullUrl": resource_urn,
                "resource": resource,
                "request": {
                    "method": "POST",
                    "url": resource["resourceType"],
                    "ifNoneExist": f"identifier={commit_ident['system']}|{commit_ident['value']}",
                },
            },
            {"resource": provenance, "request": {"method": "POST", "url": "Provenance"}},
            {"resource": task_done, "request": {"method": "PUT", "url": f"Task/{task_id}"}},
        ],
    }
    result = medplum.post_bundle(bundle)
    committed = result["entry"][0]["response"]["location"]
    return {"committed": committed, "task_id": task_id}


def reject_task(medplum: MedplumFhirClient, task_id: str) -> None:
    """Reject a pending proposal: Task → rejected, no clinical resource is ever
    created, the proposal Binary and source document remain for audit."""
    task = medplum.get(f"Task/{task_id}")
    if task.get("status") != "requested":
        raise ValueError(f"task is {task.get('status')}, expected 'requested'")
    task["status"] = "rejected"
    medplum.update(task)
