"""AI Health Review pipeline: FHIR window query → compact context →
grounded summary via the configured provider → markdown + PDF stored back
into the CDR as a DocumentReference.

Guardrails (non-negotiable, see CLAUDE.md §6): organizes and summarizes the
owner's own data only — no diagnosis, prescribing or treatment advice;
concerning patterns are framed as "to discuss with your clinician"; the
disclaimer rides on every summary and PDF.
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from . import fhir_consts as fc
from .medplum import MedplumFhirClient
from .pdfgen import markdown_to_pdf
from .providers import get_provider

SYSTEM_PROMPT = f"""You are a health-data summarizer preparing notes to help a person discuss
their health with their clinician. You are given aggregated data from their personal health
record. Rules you must follow strictly:

- Organize and summarize ONLY. Never diagnose, never suggest medication or dosage changes,
  never give treatment advice, never state clinical conclusions as fact.
- Be strictly grounded in the provided data. Never invent values, dates, or events. If data
  is sparse or missing, say so plainly in the "Data gaps" section.
- Frame anything concerning as an item "to discuss with your clinician" — factual, no alarmism.
- Medications flagged life_critical=true come first wherever medications are discussed, and
  any adherence gaps on them are listed first under notable items.
- Summarize mood/mental-health data supportively and neutrally. If the data shows sustained
  serious distress, gently note that professional support resources exist — without alarmism.
- Use neutral framing for weight (trends only, no targets or judgements).
- Write clean markdown with exactly these sections, in order:
  # Health Review
  ## Current medications & adherence
  ## Recent vitals & labs
  ## Sleep
  ## Weight
  ## Symptoms & side effects
  ## Mood & mental wellbeing
  ## Notable trends
  ## Items to discuss with your clinician
  ## Data gaps
- Keep it compact and readable — this is printed for a medical visit.
- End with this exact line: "{fc.DISCLAIMER}"
"""


def _iso_date(days_ago: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).strftime("%Y-%m-%d")


def collect_context(medplum: MedplumFhirClient, window_days: int) -> dict[str, Any]:
    """Query the CDR and reduce to compact aggregates — not raw resource dumps."""
    since = _iso_date(window_days)

    requests = medplum.search_resources(
        "MedicationRequest", {"status": "active", "_include": "MedicationRequest:medication", "_count": 100}
    )
    med_names: dict[str, str] = {}
    med_requests = []
    for res in requests:
        if res["resourceType"] == "Medication":
            med_names[res["id"]] = res.get("code", {}).get("text", "Unnamed medication")
        elif res["resourceType"] == "MedicationRequest":
            med_requests.append(res)

    admins = medplum.search_resources(
        "MedicationAdministration", {"effective-time": f"ge{since}", "_count": 1000}
    )
    by_request: dict[str, list[dict]] = defaultdict(list)
    for adm in admins:
        ref = adm.get("request", {}).get("reference", "")
        by_request[ref.split("/")[-1]].append(adm)

    medications = []
    for req in med_requests:
        med_id = req.get("medicationReference", {}).get("reference", "").split("/")[-1]
        life_critical = any(
            ext.get("url") == fc.EXT_LIFE_CRITICAL and ext.get("valueBoolean")
            for ext in req.get("extension", [])
        )
        logs = by_request.get(req["id"], [])
        taken = sum(1 for a in logs if a.get("status") == "completed")
        not_done = [a for a in logs if a.get("status") == "not-done"]
        missed_dates = sorted(a.get("effectiveDateTime", "")[:10] for a in not_done)
        logged = taken + len(not_done)
        medications.append(
            {
                "name": med_names.get(med_id, "Unnamed medication"),
                "instructions": (req.get("dosageInstruction") or [{}])[0].get("text", ""),
                "life_critical": life_critical,
                "doses_taken": taken,
                "doses_not_taken": len(not_done),
                "adherence_pct_of_logged": round(100 * taken / logged) if logged else None,
                "not_taken_dates": missed_dates,
            }
        )
    medications.sort(key=lambda m: not m["life_critical"])

    observations = medplum.search_resources("Observation", {"date": f"ge{since}", "_count": 1000})
    series: dict[str, list[tuple[str, Any]]] = defaultdict(list)
    symptoms = []
    for obs in observations:
        coding = (obs.get("code", {}).get("coding") or [{}])[0]
        code = coding.get("code", "")
        when = obs.get("effectiveDateTime") or obs.get("effectivePeriod", {}).get("end", "")
        if coding.get("system") == fc.LOINC and code == "29463-7":
            series["weight_kg"].append((when[:10], obs.get("valueQuantity", {}).get("value")))
        elif code in ("mood", "energy"):
            series[code].append((when[:10], obs.get("valueInteger")))
        elif code == "sleep-duration":
            series["sleep_hours"].append((when[:10], obs.get("valueQuantity", {}).get("value")))
        elif code == "symptom":
            symptoms.append({"date": when[:10], "description": obs.get("valueString", "")})
        elif obs.get("category", [{}])[0].get("coding", [{}])[0].get("code") == "laboratory":
            series.setdefault("labs", []).append(
                (when[:10], f"{obs.get('code', {}).get('text', code)}: {obs.get('valueQuantity', {}).get('value')}")
            )

    def summarize_series(values: list[tuple[str, Any]]) -> dict[str, Any] | None:
        clean = sorted((d, v) for d, v in values if v is not None)
        if not clean:
            return None
        nums = [v for _, v in clean if isinstance(v, (int, float))]
        return {
            "count": len(clean),
            "first": {"date": clean[0][0], "value": clean[0][1]},
            "latest": {"date": clean[-1][0], "value": clean[-1][1]},
            "average": round(sum(nums) / len(nums), 1) if nums else None,
        }

    conditions = [
        {
            "text": c.get("code", {}).get("text", ""),
            "status": (c.get("clinicalStatus", {}).get("coding") or [{}])[0].get("code", ""),
        }
        for c in medplum.search_resources("Condition", {"_count": 100})
    ]
    reports_total = medplum.search("DiagnosticReport", {"_count": 0, "_total": "accurate"}).get("total", 0)

    return {
        "window_days": window_days,
        "window_start": since,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "medications": medications,
        "weight_kg": summarize_series(series.get("weight_kg", [])),
        "sleep_hours": summarize_series(series.get("sleep_hours", [])),
        "mood_1_to_10": summarize_series(series.get("mood", [])),
        "energy_1_to_10": summarize_series(series.get("energy", [])),
        "symptoms": symptoms[:50],
        "recent_lab_values": series.get("labs", [])[-20:],
        "conditions": conditions,
        "lab_report_count_all_time": reports_total,
    }


def run_health_review(medplum: MedplumFhirClient, window_days: int, patient_id: str) -> dict[str, Any]:
    provider = get_provider()  # raises ProviderNotConfigured with a friendly reason
    context = collect_context(medplum, window_days)

    user_prompt = (
        f"Data window: last {window_days} days (since {context['window_start']}). "
        f"Generated {context['generated_at']}.\n\n"
        "Aggregated personal health record data (JSON):\n\n"
        + json.dumps(context, indent=2, default=str)
    )
    markdown = provider.generate(SYSTEM_PROMPT, user_prompt)

    header = (
        f"> **{fc.DISCLAIMER}**\n>\n"
        f"> Window: last {window_days} days · generated {context['generated_at']} · "
        f"provider: {provider.name} ({provider.model})\n\n"
    )
    markdown = header + markdown

    pdf_bytes = markdown_to_pdf(markdown, title="HealMeDaily Health Review")
    md_binary = medplum.create_binary(markdown.encode(), "text/markdown")
    pdf_binary = medplum.create_binary(pdf_bytes, "application/pdf")

    doc_ref = medplum.create(
        {
            "resourceType": "DocumentReference",
            "status": "current",
            "type": {"coding": [{"system": fc.CS_DOC, "code": "health-review"}], "text": "AI Health Review"},
            "subject": {"reference": f"Patient/{patient_id}"},
            "date": context["generated_at"],
            "description": f"Health Review — last {window_days} days",
            "content": [
                {"attachment": {"url": f"Binary/{md_binary['id']}", "contentType": "text/markdown"}},
                {
                    "attachment": {
                        "url": f"Binary/{pdf_binary['id']}",
                        "contentType": "application/pdf",
                        "title": "health-review.pdf",
                    }
                },
            ],
        }
    )
    return {
        "document_reference_id": doc_ref["id"],
        "generated_at": context["generated_at"],
        "window_days": window_days,
        "markdown": markdown,
    }


def latest_review(medplum: MedplumFhirClient) -> dict[str, Any] | None:
    docs = medplum.search_resources(
        "DocumentReference",
        {"type": f"{fc.CS_DOC}|health-review", "_sort": "-date", "_count": 1},
    )
    if not docs:
        return None
    doc = docs[0]
    md_url = next(
        (c["attachment"]["url"] for c in doc.get("content", []) if c["attachment"].get("contentType") == "text/markdown"),
        None,
    )
    markdown = medplum.read_binary(md_url.split("/")[-1]).decode() if md_url else ""
    return {
        "document_reference_id": doc["id"],
        "generated_at": doc.get("date"),
        "description": doc.get("description", ""),
        "markdown": markdown,
    }


def review_pdf(medplum: MedplumFhirClient, doc_id: str) -> bytes:
    doc = medplum.get(f"DocumentReference/{doc_id}")
    pdf_url = next(
        (c["attachment"]["url"] for c in doc.get("content", []) if c["attachment"].get("contentType") == "application/pdf"),
        None,
    )
    if not pdf_url:
        raise KeyError("no PDF attachment on this review")
    return medplum.read_binary(pdf_url.split("/")[-1])
