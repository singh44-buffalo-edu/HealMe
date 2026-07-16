"""Record-grounded Assistant + natural-language quick capture (Phase 7).

POST /assistant/ask answers the owner's questions strictly from their own
record: every context element handed to the model carries a stable citation
tag [n], and every factual claim in the answer must cite one.

READ-ONLY INVARIANT: the assistant never creates or updates any clinical
resource. Its only writes are its own Communication Q&A log (Communication,
category local `assistant-qa` — deletable via DELETE /assistant/sessions/{id},
which leaves an AuditEvent stub) and AuditEvent entries for the cloud-boundary
ledger. Enforced by construction: the /ask and /sessions code paths contain no
other create/update call.

POST /assistant/nl-import turns a short natural-language note ("weighed 70.4
this morning, slept 6h") into ingestion *proposals* riding the exact same
review queue as document ingestion (ingest.py): raw text Binary +
DocumentReference (local type `nl-capture`) + one proposal Binary + review
Task per candidate. Nothing commits until the owner approves — the review-gate
invariant of CLAUDE.md §6 holds here too.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import fhir_consts as fc
from .ai_settings import get_provider_for, log_boundary_event
from .config import settings
from .health_review import collect_context
from .ingest import ALLOWED_RESOURCE_TYPES, PROPOSAL_SCHEMA
from .medplum import MedplumError, medplum
from .providers import ProviderError, ProviderNotConfigured

CS_COMM = f"{fc.BASE}/CodeSystem/communication"
ASSISTANT_QA = "assistant-qa"
NL_IMPORT_IDENT = f"{fc.IDENT}/nl-import"
OBS_CATEGORY = "http://terminology.hl7.org/CodeSystem/observation-category"

# One year of record context: wide enough for "since my last visit" questions
# while keeping the prompt within every provider's context budget.
CONTEXT_WINDOW_DAYS = 365
MAX_OBS_PER_CODE = 6  # newest per measure — keeps the context block compact

router = APIRouter(prefix="/assistant", tags=["assistant"])


ASSISTANT_SYSTEM = """You are the record assistant of a personal health record app. You answer the
owner's questions about what THEIR OWN record shows. Rules you must follow strictly:

- Organize and report ONLY. Never diagnose, never suggest starting, stopping or changing a
  medication or dose, never give treatment advice, never state clinical conclusions as fact.
- Anything concerning is framed factually as an item "to discuss with your clinician" — no alarmism.
- Be strictly grounded in the record context below: every factual claim must cite the [n] tag(s)
  of the element(s) it comes from, inline in answer_markdown (e.g. "70.4 kg on 2026-07-10 [12]").
- Use only [n] tags that appear in the context, and list every tag you cited in `citations`.
- If the record does not contain what is needed to answer, say so plainly — never guess and
  never fill gaps from general knowledge.
- Neutral framing for weight (trends only, no targets); supportive, neutral tone for mood data.
- Keep the answer compact, markdown-formatted.
- Set read_count to the number of record elements you actually used.
"""

ANSWER_SCHEMA = {
    "type": "object",
    "properties": {
        "answer_markdown": {
            "type": "string",
            "description": "grounded markdown answer with inline [n] citations",
        },
        "citations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "n": {"type": "integer"},
                    "resourceType": {"type": "string"},
                    "id": {"type": "string"},
                    "display": {"type": "string"},
                },
                "required": ["n", "resourceType", "id"],
                "additionalProperties": False,
            },
        },
        "read_count": {"type": "integer", "description": "how many record elements were used"},
    },
    "required": ["answer_markdown", "citations", "read_count"],
    "additionalProperties": False,
}

NL_IMPORT_SYSTEM = f"""You turn the owner's short natural-language health note into proposed FHIR R4
resources for their personal record. Proposals go to a human review queue — nothing is committed
without explicit approval. Rules:

- Propose only what the note actually states. Never invent values, dates, codes, or diagnoses.
- Allowed resource types: {", ".join(ALLOWED_RESOURCE_TYPES)}.
- Every proposed resource is valid FHIR R4 JSON with "subject"/"patient" set to
  {{"reference": "Patient/PATIENT_ID"}} (literally PATIENT_ID — it is substituted later).
- Category codings use system {OBS_CATEGORY}.
- Use this app's exact tracker shapes (code system {fc.CS_OBS} unless noted):
  - weight → Observation, category vital-signs, code {fc.LOINC}|29463-7 "Body weight",
    valueQuantity in kg (unit system {fc.UCUM}, code "kg")
  - sleep → Observation, category survey, code sleep-duration "Sleep duration",
    valueQuantity in hours (unit system {fc.UCUM}, code "h")
  - mood or energy on a 1-10 scale → Observation, category survey, code mood / energy, valueInteger
  - symptom → Observation, category survey, code symptom (code.text "Symptom"),
    valueString = the symptom in the person's own words
- Any other coding: verified LOINC / SNOMED / RxNorm codes ONLY when certain; otherwise use
  {{"text": "<original words>"}} with no coding array. Never guess codes.
- effectiveDateTime: resolve relative words ("this morning", "last night") against the current
  local time provided; use a date-only value when no time is stated.
- confidence is your honest 0-1 faithfulness estimate; source_excerpt quotes the exact words of
  the note that support the proposal.
"""


# --- Shared plumbing ------------------------------------------------------------


def _wrap(fn, *args, **kwargs):
    """Same error → HTTP mapping as main.py so this router degrades identically
    (503 ProviderNotConfigured drives the frontend's "configure a provider" state)."""
    try:
        return fn(*args, **kwargs)
    except ProviderNotConfigured as err:
        raise HTTPException(status_code=503, detail=str(err)) from err
    except ProviderError as err:
        raise HTTPException(status_code=502, detail=str(err)) from err
    except MedplumError as err:
        raise HTTPException(status_code=502, detail=f"Medplum: {err}") from err
    except (ValueError, KeyError) as err:
        raise HTTPException(status_code=400, detail=str(err)) from err


def _patient_id() -> str:
    if not settings.medplum_patient_id:
        raise HTTPException(status_code=503, detail="MEDPLUM_PATIENT_ID not set — run make seed")
    return settings.medplum_patient_id


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --- Citation-tagged context -----------------------------------------------------


def _cite(
    citations: list[dict[str, Any]],
    resource_type: str,
    resource_id: str,
    display: str,
    value: Any = None,
    date: str | None = None,
) -> str:
    """Register one record element and return its stable [n] tag."""
    n = len(citations) + 1
    citations.append(
        {"n": n, "resourceType": resource_type, "id": resource_id, "display": display, "value": value, "date": date}
    )
    return f"[{n}]"


def _obs_label(obs: dict[str, Any]) -> str:
    """Human label for an Observation: code.text, else first coding display/code."""
    code = obs.get("code") or {}
    if code.get("text"):
        return code["text"]
    coding = (code.get("coding") or [{}])[0]
    return coding.get("display") or coding.get("code") or "Observation"


def _obs_value(obs: dict[str, Any]) -> str:
    """Render any value[x] variant this app writes as a compact display string."""
    if "valueQuantity" in obs:
        q = obs["valueQuantity"]
        return f"{q.get('value')} {q.get('unit') or q.get('code') or ''}".strip()
    if "valueInteger" in obs:
        return str(obs["valueInteger"])
    if "valueString" in obs:
        return str(obs["valueString"])
    if "valueCodeableConcept" in obs:
        return (obs["valueCodeableConcept"] or {}).get("text", "")
    if "valueBoolean" in obs:
        return "yes" if obs["valueBoolean"] else "no"
    return ""


def _obs_date(obs: dict[str, Any]) -> str:
    """Clinical date (YYYY-MM-DD) from effectiveDateTime or the period bounds."""
    period = obs.get("effectivePeriod") or {}
    when = obs.get("effectiveDateTime") or period.get("end") or period.get("start") or ""
    return when[:10]


def _build_context(client: Any) -> tuple[str, list[dict[str, Any]]]:
    """Compact record context where EVERY data element carries a [n] citation tag.

    Reuses collect_context (health_review) for the adherence aggregates, plus
    targeted id-bearing queries so each tag resolves to a real resource."""
    aggregates = collect_context(client, CONTEXT_WINDOW_DAYS)
    citations: list[dict[str, Any]] = []
    lines = [
        f"Window: last {CONTEXT_WINDOW_DAYS} days (since {aggregates['window_start']}). "
        "Every element ends with its citation tag [n]."
    ]

    # Medications: adherence aggregates merged onto the id-bearing requests.
    results = client.search_resources(
        "MedicationRequest", {"status": "active", "_include": "MedicationRequest:medication", "_count": 100}
    )
    med_names = {
        r["id"]: r.get("code", {}).get("text", "Unnamed medication")
        for r in results
        if r["resourceType"] == "Medication"
    }
    agg_by_name = {m["name"]: m for m in aggregates.get("medications", [])}
    med_lines = []
    for req in (r for r in results if r["resourceType"] == "MedicationRequest"):
        name = med_names.get(
            req.get("medicationReference", {}).get("reference", "").split("/")[-1], "Unnamed medication"
        )
        agg = agg_by_name.get(name, {})
        sig = agg.get("instructions") or (req.get("dosageInstruction") or [{}])[0].get("text", "")
        detail = name + (" [LIFE-CRITICAL]" if agg.get("life_critical") else "") + (f" — {sig}" if sig else "")
        if agg.get("doses_taken") is not None:
            detail += f"; dose log in window: {agg['doses_taken']} taken, {agg['doses_not_taken']} not taken"
            if agg.get("not_taken_dates"):
                detail += f" (not taken on {', '.join(agg['not_taken_dates'][:10])})"
        tag = _cite(
            citations, "MedicationRequest", req["id"], name, sig or None, req.get("authoredOn", "")[:10] or None
        )
        med_lines.append(f"- {detail} {tag}")
    if med_lines:
        lines += ["", "## Active medications & dose log", *med_lines]

    # Observations: newest first per measure (server-sorted), capped per code.
    observations = client.search_resources(
        "Observation", {"date": f"ge{aggregates['window_start']}", "_sort": "-date", "_count": 1000}
    )
    groups: dict[str, list[dict[str, Any]]] = {}
    for obs in observations:
        groups.setdefault(_obs_label(obs), []).append(obs)
    obs_lines = []
    for label in sorted(groups):
        for obs in groups[label][:MAX_OBS_PER_CODE]:
            value, date = _obs_value(obs), _obs_date(obs)
            display = f"{label} on {date}" if date else label
            tag = _cite(citations, "Observation", obs.get("id", ""), display, value or None, date or None)
            obs_lines.append(f"- {date or 'undated'} · {label}: {value or '(no value)'} {tag}")
    if obs_lines:
        lines += ["", f"## Observations (newest {MAX_OBS_PER_CODE} per measure)", *obs_lines]

    condition_lines = []
    for cond in client.search_resources("Condition", {"_count": 100}):
        text = cond.get("code", {}).get("text", "Unnamed condition")
        status = (cond.get("clinicalStatus", {}).get("coding") or [{}])[0].get("code", "")
        tag = _cite(
            citations, "Condition", cond.get("id", ""), text, status or None, cond.get("recordedDate", "")[:10] or None
        )
        condition_lines.append(f"- {text}" + (f" ({status})" if status else "") + f" {tag}")
    if condition_lines:
        lines += ["", "## Conditions on record", *condition_lines]

    if not citations:
        lines += ["", "The record contains no data elements in this window."]
    return "\n".join(lines), citations


# --- POST /assistant/ask ----------------------------------------------------------


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)


def _ask(question: str) -> dict[str, Any]:
    """Core Q&A flow: build citation-tagged context → boundary ledger (cloud
    only) → structured model call → server-side citation verification → log
    the exchange as a Communication. FHIR touched: reads MedicationRequest/
    Observation/Condition (+ health_review aggregates); writes Communication
    and, for cloud routes, one AuditEvent."""
    patient_id = _patient_id()
    provider = get_provider_for("assistant")  # ProviderNotConfigured → 503 before any read
    context_block, index = _build_context(medplum)
    if not provider.is_local:
        # Boundary ledger: written BEFORE any data leaves this device.
        log_boundary_event(
            medplum, "assistant", provider.name, f"Assistant Q&A · {len(index)} record elements in context"
        )

    user_prompt = (
        "Record context — the only source of truth for your answer:\n\n"
        f"{context_block}\n\n"
        f"Question from the record owner: {question}"
    )
    result = provider.generate_json(ASSISTANT_SYSTEM, user_prompt, ANSWER_SCHEMA)

    answer = str(result.get("answer_markdown") or "").strip()
    if not answer:
        raise ProviderError("Empty assistant answer")
    # Citations are server-authoritative: keep only tags that exist in the
    # context index, and return the index entry — a hallucinated resource id
    # can never reach the client.
    by_n = {c["n"]: c for c in index}
    cited: list[dict[str, Any]] = []
    seen: set[int] = set()
    for c in result.get("citations") or []:
        try:
            n = int(c.get("n"))
        except (TypeError, ValueError):
            continue
        if n in by_n and n not in seen:
            seen.add(n)
            cited.append(by_n[n])
    cited.sort(key=lambda c: c["n"])
    try:
        read_count = int(result.get("read_count"))
    except (TypeError, ValueError):
        read_count = 0
    if read_count <= 0:
        read_count = len(cited) or len(index)

    communication = medplum.create(
        {
            "resourceType": "Communication",
            "status": "completed",
            "category": [{"coding": [{"system": CS_COMM, "code": ASSISTANT_QA}], "text": "Assistant Q&A"}],
            "subject": {"reference": f"Patient/{patient_id}"},
            "sent": _now(),
            # payload[0] = question, payload[1] = answer markdown (positional, see sessions()).
            "payload": [{"contentString": question}, {"contentString": answer}],
        }
    )
    return {
        "answer_markdown": answer,
        "citations": cited,
        "read_count": read_count,
        "provider": {"name": provider.name, "is_local": provider.is_local},
        "communication_id": communication["id"],
        "disclaimer": fc.DISCLAIMER,
    }


@router.post("/ask")
def ask(body: AskRequest) -> dict[str, Any]:
    """Answer one question strictly from the owner's record. Returns grounded
    markdown + server-verified citations + provider info + disclaimer. Reads
    the CDR; writes only the Communication Q&A log (and the boundary
    AuditEvent when routed to a cloud provider). 503 when the 'assistant'
    feature is off/unconfigured."""
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="question must not be blank")
    return _wrap(_ask, question)


# --- Sessions ---------------------------------------------------------------------


def _is_assistant_session(comm: dict[str, Any]) -> bool:
    """True only for Communications carrying our local assistant-qa category —
    the guard that keeps DELETE /sessions from touching anything else."""
    return any(
        coding.get("system") == CS_COMM and coding.get("code") == ASSISTANT_QA
        for cat in comm.get("category", [])
        for coding in cat.get("coding", [])
    )


@router.get("/sessions")
def sessions() -> list[dict[str, Any]]:
    """List past Q&A sessions (newest first, capped at 50) for the Assistant
    page sidebar. Payload positions are contractual: [0]=question, [1]=answer."""
    comms = _wrap(
        medplum.search_resources,
        "Communication",
        {"category": f"{CS_COMM}|{ASSISTANT_QA}", "_sort": "-sent", "_count": 50},
    )
    out = []
    for comm in comms:
        payloads = [p.get("contentString", "") for p in comm.get("payload", [])]
        answer = payloads[1] if len(payloads) > 1 else ""
        out.append(
            {
                "id": comm.get("id"),
                "question": payloads[0] if payloads else "",
                "answer_preview": answer[:200],
                "sent": comm.get("sent"),
            }
        )
    return out


@router.delete("/sessions/{session_id}")
def delete_session(session_id: str) -> dict[str, Any]:
    """Hard-delete one Q&A session (owner's right to forget a conversation).
    Only assistant-qa Communications qualify — anything else 404s. Leaves an
    AuditEvent stub: content gone, the deletion itself stays on record."""
    try:
        comm = medplum.get(f"Communication/{session_id}")
    except MedplumError as err:
        if "404" in str(err):
            raise HTTPException(status_code=404, detail="no such assistant session") from err
        raise HTTPException(status_code=502, detail=f"Medplum: {err}") from err
    if not _is_assistant_session(comm):
        # This endpoint may only ever delete the assistant's own Q&A log.
        raise HTTPException(status_code=404, detail="not an assistant session")

    resp = medplum.request("DELETE", f"Communication/{session_id}")
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Medplum: delete failed ({resp.status_code})")

    # Per design, deleting a session leaves an audit stub: the content is gone,
    # the fact that a session was deleted is not.
    _wrap(
        medplum.create,
        {
            "resourceType": "AuditEvent",
            "type": {
                "system": "http://terminology.hl7.org/CodeSystem/audit-event-type",
                "code": "rest",
                "display": "RESTful Operation",
            },
            "action": "D",
            "recorded": _now(),
            "outcome": "0",
            "agent": [{"name": "healmedaily-ai", "requestor": True}],
            "source": {"observer": {"display": "healmedaily-ai"}},
            "entity": [{"name": f"Communication/{session_id}", "description": "assistant session deleted"}],
        },
    )
    return {"id": session_id, "deleted": True}


# --- POST /assistant/nl-import ------------------------------------------------------


class NlImportRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


def _ident(payload: str) -> dict[str, str]:
    # Same content-hash pattern as importers._hash_ident — replay-safe writes.
    return {"system": NL_IMPORT_IDENT, "value": hashlib.sha256(payload.encode()).hexdigest()[:32]}


def _create_with_ident(client: Any, resource: dict[str, Any], ident: dict[str, str]) -> dict[str, Any]:
    """Conditional create (If-None-Exist on a stable content-hash identifier) so
    a replayed capture cannot duplicate DocumentReferences or review Tasks."""
    resource.setdefault("identifier", []).append(ident)
    resp = client.request(
        "POST",
        resource["resourceType"],
        json=resource,
        headers={"If-None-Exist": f"identifier={ident['system']}|{ident['value']}"},
    )
    if resp.status_code >= 400:
        raise MedplumError(f"create {resource['resourceType']}: {resp.status_code} {resp.text[:300]}")
    return resp.json()


def _nl_import(text: str) -> dict[str, Any]:
    """Core NL-capture flow: boundary ledger (cloud only) → structured model
    call → store raw note (Binary + DocumentReference `nl-capture`) → one
    proposal Binary + review Task per candidate. All writes are conditional
    creates on content-hash identifiers, so replaying the same note is a
    no-op. Nothing clinical commits here — approval does that (ingest.py)."""
    patient_id = _patient_id()
    provider = get_provider_for("nl-import")  # ProviderNotConfigured → 503 before any write
    if not provider.is_local:
        # Boundary ledger: written BEFORE the note leaves this device.
        log_boundary_event(medplum, "nl-import", provider.name, f"NL quick capture · {len(text)} chars")

    try:
        tz = ZoneInfo(settings.hmd_time_zone)
    except Exception:  # noqa: BLE001 — a bad TZ name must not break capture
        tz = timezone.utc
    user_prompt = (
        f"Current local time: {datetime.now(tz).isoformat(timespec='minutes')} ({settings.hmd_time_zone}).\n\n"
        f"Note to structure:\n{text}"
    )
    result = provider.generate_json(NL_IMPORT_SYSTEM, user_prompt, PROPOSAL_SCHEMA)

    candidates: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for proposal in result.get("proposals") or []:
        try:
            resource = json.loads(proposal["resource_json"])
        except (json.JSONDecodeError, TypeError, KeyError):
            continue
        if resource.get("resourceType") not in ALLOWED_RESOURCE_TYPES:
            continue
        candidates.append((proposal, resource))
    if not candidates:
        return {"proposals": 0, "task_ids": [], "note": "No structurable data found in the note."}

    now = _now()
    # The raw note is the source document of the proposal gate: Binary + a
    # DocumentReference typed with the local `nl-capture` code, exactly like
    # ingest.py's uploaded-document pattern.
    raw_binary = medplum.create_binary(text.encode(), "text/plain")
    doc_ref = _create_with_ident(
        medplum,
        {
            "resourceType": "DocumentReference",
            "status": "current",
            "type": {"coding": [{"system": fc.CS_DOC, "code": "nl-capture"}], "text": "Natural-language capture"},
            "subject": {"reference": f"Patient/{patient_id}"},
            "date": now,
            "description": text[:80],
            "content": [{"attachment": {"url": f"Binary/{raw_binary['id']}", "contentType": "text/plain"}}],
        },
        _ident(f"{patient_id}|doc|{text}"),
    )

    task_ids = []
    for i, (proposal, resource) in enumerate(candidates):
        payload = json.dumps(resource).replace("PATIENT_ID", patient_id)
        proposal_binary = medplum.create_binary(payload.encode(), "application/fhir+json")
        try:
            confidence = float(proposal.get("confidence") or 0)
        except (TypeError, ValueError):
            confidence = 0.0
        task = _create_with_ident(
            medplum,
            {
                "resourceType": "Task",
                "status": "requested",
                "intent": "proposal",
                "code": {"coding": [{"system": fc.CS_INGEST, "code": "review-ingestion-proposal"}]},
                "description": proposal.get("description", "Proposed capture"),
                "for": {"reference": f"Patient/{patient_id}"},
                "focus": {"reference": f"DocumentReference/{doc_ref['id']}"},
                "authoredOn": now,
                "input": [
                    {
                        "type": {"coding": [{"system": fc.CS_INGEST, "code": "candidate"}]},
                        "valueReference": {"reference": f"Binary/{proposal_binary['id']}"},
                    },
                    {
                        "type": {"coding": [{"system": fc.CS_INGEST, "code": "confidence"}]},
                        "valueDecimal": max(0.0, min(1.0, confidence)),
                    },
                    {
                        "type": {"coding": [{"system": fc.CS_INGEST, "code": "raw-excerpt"}]},
                        "valueString": str(proposal.get("source_excerpt") or text)[:1000],
                    },
                ],
            },
            _ident(f"{patient_id}|task|{i}|{payload}"),
        )
        task_ids.append(task["id"])
    return {"proposals": len(task_ids), "task_ids": task_ids, "document_reference_id": doc_ref["id"]}


@router.post("/nl-import")
def nl_import(body: NlImportRequest) -> dict[str, Any]:
    """Natural-language quick capture → review-queue proposals (never direct
    commits — the FHIR-MAPPING §6 gate verbatim). Returns proposal count and
    Task ids; the owner approves/rejects them on the Review page exactly like
    document extractions. Replay-safe via content-hash identifiers."""
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text must not be blank")
    return _wrap(_nl_import, text)
