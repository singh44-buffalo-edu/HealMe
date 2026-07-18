"""AI Health Review pipeline: FHIR window query → compact context →
grounded summary via the configured provider → markdown + PDF stored back
into the CDR as a DocumentReference (local type `health-review`).

Called from main.py (/health-review*); collect_context is also reused by
assistant.py for its adherence aggregates. Two variants share the storage
path: run_health_review (AI-generated) and run_data_summary (deterministic,
zero AI — works with no provider configured, spec FR-RPT-1/2).

Guardrails (non-negotiable, see CLAUDE.md §6): organizes and summarizes the
owner's own data only — no diagnosis, prescribing or treatment advice;
concerning patterns are framed as "to discuss with your clinician"; the
disclaimer rides on every summary and PDF; life-critical medication gaps are
listed first (owner decision, CLAUDE.md §8); weight is framed neutrally
(trends only, no targets).
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from . import fhir_consts as fc
from .medplum import MedplumFhirClient
from .pdfgen import markdown_to_pdf

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
    """UTC date N days back — the `ge` bound for all window searches."""
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).strftime("%Y-%m-%d")


# Hard ceiling on the window queries below: 25 pages × _count=1000 per query,
# followed via Bundle.link.next (medplum.search_all). Far beyond hand-logged
# volumes, but a long window over Apple-Health-scale imports can exceed it —
# then the newest rows win (_sort descending) and the context is explicitly
# flagged as truncated so the summary can disclose the gap instead of quietly
# reporting on a partial record.
CONTEXT_MAX_PAGES = 25


def collect_context(medplum: MedplumFhirClient, window_days: int) -> dict[str, Any]:
    """Query the CDR and reduce to compact aggregates — not raw resource dumps
    (keeps the prompt small AND limits what ever leaves the device on cloud
    routes). Reads MedicationRequest(+Medication via _include),
    MedicationAdministration, Observation, Condition, DiagnosticReport count.

    Adherence semantics (FHIR-MAPPING §3): only logged events exist —
    'completed' = taken, 'not-done' = skipped/missed; no log means no resource,
    so percentages are "of logged doses", never of the theoretical schedule."""
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

    admins, admins_truncated = medplum.search_all(
        "MedicationAdministration",
        {"effective-time": f"ge{since}", "_sort": "-effective-time", "_count": 1000},
        max_pages=CONTEXT_MAX_PAGES,
    )
    by_request: dict[str, list[dict]] = defaultdict(list)
    for adm in admins:
        ref = adm.get("request", {}).get("reference", "")
        by_request[ref.split("/")[-1]].append(adm)

    medications = []
    for req in med_requests:
        med_id = req.get("medicationReference", {}).get("reference", "").split("/")[-1]
        life_critical = any(
            ext.get("url") == fc.EXT_LIFE_CRITICAL and ext.get("valueBoolean") for ext in req.get("extension", [])
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
    # Life-critical meds first — mirrored by the prompt rule so gaps on them
    # top the "notable items" section (medical-safety behavior, CLAUDE.md §8).
    medications.sort(key=lambda m: not m["life_critical"])

    # Bucket observations into named series by this app's tracker codes
    # (FHIR-MAPPING §4): LOINC 29463-7 = weight, local mood/energy/
    # sleep-duration/symptom/rx-question, plus any laboratory-category value.
    # Fetched newest-first (truncation clips the oldest edge), then reversed
    # to ascending so the [-N:] slices below keep the RECENT entries.
    observations, obs_truncated = medplum.search_all(
        "Observation",
        {"date": f"ge{since}", "_sort": "-date", "_count": 1000},
        max_pages=CONTEXT_MAX_PAGES,
    )
    observations.reverse()
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
        elif code == "rx-question":
            series.setdefault("rx_questions", []).append((when[:10], obs.get("valueString", "")))
        elif obs.get("category", [{}])[0].get("coding", [{}])[0].get("code") == "laboratory":
            series.setdefault("labs", []).append(
                (when[:10], f"{obs.get('code', {}).get('text', code)}: {obs.get('valueQuantity', {}).get('value')}")
            )

    def summarize_series(values: list[tuple[str, Any]]) -> dict[str, Any] | None:
        """(date, value) series → count/first/latest/average, or None when empty
        — first vs latest lets the model state trends without raw dumps."""
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

    context: dict[str, Any] = {
        "window_days": window_days,
        "window_start": since,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "medications": medications,
        "weight_kg": summarize_series(series.get("weight_kg", [])),
        "sleep_hours": summarize_series(series.get("sleep_hours", [])),
        "mood_1_to_10": summarize_series(series.get("mood", [])),
        "energy_1_to_10": summarize_series(series.get("energy", [])),
        "symptoms": symptoms[-50:],
        "recent_lab_values": series.get("labs", [])[-20:],
        "questions_for_prescriber": [{"date": d, "question": q} for d, q in series.get("rx_questions", [])[-20:]],
        "conditions": conditions,
        "lab_report_count_all_time": reports_total,
    }
    if admins_truncated or obs_truncated:
        # Honest-data disclosure: the key rides into the JSON handed to the AI
        # (its prompt requires gaps in the "Data gaps" section) and
        # build_data_summary prints it — a summary over partial data must say so.
        context["window_truncated"] = (
            f"Data gap: the window holds more records than the query ceiling "
            f"({CONTEXT_MAX_PAGES * 1000} per query); the oldest entries were not read. "
            "Aggregates cover the newest records only."
        )
    return context


def build_data_summary(context: dict[str, Any]) -> str:
    """Deterministic, data-only clinician summary — no AI involved, works with
    no provider configured. Data and user-authored questions only; never a
    diagnosis, severity assessment, or recommendation."""
    lines: list[str] = ["# Health data summary (no AI — data only)", ""]

    lines.append("## Current medications & adherence")
    if context["medications"]:
        for med in context["medications"]:
            flag = " **[life-critical]**" if med["life_critical"] else ""
            pct = med["adherence_pct_of_logged"]
            lines.append(
                f"- **{med['name']}**{flag} — {med['instructions'] or 'no instructions recorded'}. "
                f"Logged doses: {med['doses_taken']} taken, {med['doses_not_taken']} not taken"
                + (f" ({pct}% of logged)" if pct is not None else "")
            )
            if med["not_taken_dates"]:
                lines.append(f"  - Not taken on: {', '.join(med['not_taken_dates'])}")
    else:
        lines.append("- No active medications recorded.")

    def series_line(label: str, key: str, unit: str) -> None:
        s = context.get(key)
        if s:
            lines.append(
                f"- **{label}**: latest {s['latest']['value']}{unit} on {s['latest']['date']}; "
                f"first in window {s['first']['value']}{unit} ({s['first']['date']}); "
                f"average {s['average']}{unit} over {s['count']} readings"
            )
        else:
            lines.append(f"- **{label}**: no data in window")

    lines += ["", "## Measurements"]
    series_line("Weight", "weight_kg", " kg")
    series_line("Sleep", "sleep_hours", " h")
    series_line("Mood (1-10)", "mood_1_to_10", "")
    series_line("Energy (1-10)", "energy_1_to_10", "")

    lines += ["", "## Recent lab values"]
    if context["recent_lab_values"]:
        for date, text in context["recent_lab_values"]:
            lines.append(f"- {date}: {text}")
    else:
        lines.append("- None in window.")

    lines += ["", "## Symptoms reported"]
    if context["symptoms"]:
        for s in context["symptoms"]:
            lines.append(f"- {s['date']}: {s['description']}")
    else:
        lines.append("- None recorded in window.")

    lines += ["", "## Questions for the prescriber (user-authored)"]
    if context["questions_for_prescriber"]:
        for q in context["questions_for_prescriber"]:
            lines.append(f"- {q['date']}: {q['question']}")
    else:
        lines.append("- None recorded.")

    if context["conditions"]:
        lines += ["", "## Conditions on record"]
        for c in context["conditions"]:
            lines.append(f"- {c['text']} ({c['status']})")

    if context.get("window_truncated"):
        lines += ["", f"> **{context['window_truncated']}**"]

    lines += ["", f"{fc.DISCLAIMER}"]
    return "\n".join(lines)


def _store_review(
    medplum: MedplumFhirClient,
    markdown: str,
    context: dict[str, Any],
    window_days: int,
    patient_id: str,
    description: str,
) -> dict[str, Any]:
    """Persist a finished review: markdown Binary + PDF Binary + one
    DocumentReference (type `health-review`) carrying both attachments, all
    with the Patient securityContext (FHIR-MAPPING §6 — review content is
    patient data). Each run appends a new document — history is kept,
    nothing overwritten."""
    pdf_bytes = markdown_to_pdf(
        markdown,
        title="HealMeDaily Health Review",
        # Disclaimer on every page footer (can't scroll off) + window/date
        # subtitle in the running header.
        footer_note=fc.DISCLAIMER,
        subtitle=f"Window: last {window_days} days · generated {context['generated_at']}",
    )
    security_context = f"Patient/{patient_id}"
    md_binary = medplum.create_binary(markdown.encode(), "text/markdown", security_context=security_context)
    pdf_binary = medplum.create_binary(pdf_bytes, "application/pdf", security_context=security_context)
    doc_ref = medplum.create(
        {
            "resourceType": "DocumentReference",
            "status": "current",
            "type": {"coding": [{"system": fc.CS_DOC, "code": "health-review"}], "text": "Health Review"},
            "subject": {"reference": f"Patient/{patient_id}"},
            "date": context["generated_at"],
            "description": description,
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


def run_data_summary(medplum: MedplumFhirClient, window_days: int, patient_id: str) -> dict[str, Any]:
    """Clinician summary without any AI provider — FR-RPT-1/2 style.
    Deterministic render of collect_context; same storage/PDF path as the AI
    review so both appear identically in the documents list."""
    context = collect_context(medplum, window_days)
    markdown = (
        f"> **{fc.DISCLAIMER}**\n>\n"
        f"> Window: last {window_days} days · generated {context['generated_at']} · data-only (no AI)\n\n"
        + build_data_summary(context)
    )
    return _store_review(
        medplum, markdown, context, window_days, patient_id, f"Data summary (no AI) — last {window_days} days"
    )


def run_health_review(medplum: MedplumFhirClient, window_days: int, patient_id: str) -> dict[str, Any]:
    """The AI review: aggregates → provider.generate → header (disclaimer +
    window + provider attribution) prepended → stored via _store_review.
    Provider errors propagate (main._wrap → 502/503); nothing is stored on
    failure, so a broken run leaves no half-written review behind.

    Routed via get_provider_for('health-review') so the AI Settings local/cloud/
    off toggle is honored, and — for a cloud route — a boundary AuditEvent is
    written BEFORE the aggregated PHI leaves this device (ai_settings module
    docstring; CLAUDE.md §6)."""
    # Lazy import avoids an import cycle (ai_settings imports providers).
    from .ai_settings import get_provider_for, log_boundary_event

    provider = get_provider_for("health-review")  # ProviderNotConfigured → 503 before any data is assembled
    context = collect_context(medplum, window_days)
    if not provider.is_local:
        # Boundary ledger: written BEFORE any data leaves this device.
        log_boundary_event(
            medplum, "health-review", provider.name, f"AI Health Review · last {window_days} days of record"
        )

    user_prompt = (
        f"Data window: last {window_days} days (since {context['window_start']}). "
        f"Generated {context['generated_at']}.\n\n"
        "Aggregated personal health record data (JSON):\n\n" + json.dumps(context, indent=2, default=str)
    )
    markdown = provider.generate(SYSTEM_PROMPT, user_prompt)

    header = (
        f"> **{fc.DISCLAIMER}**\n>\n"
        f"> Window: last {window_days} days · generated {context['generated_at']} · "
        f"provider: {provider.name} ({provider.model})\n\n"
    )
    markdown = header + markdown
    return _store_review(
        medplum, markdown, context, window_days, patient_id, f"AI Health Review — last {window_days} days"
    )


def latest_review(medplum: MedplumFhirClient) -> dict[str, Any] | None:
    """Newest `health-review` DocumentReference with its markdown body, or
    None. Uses medplum.read_attachment because Attachment.url comes back as a
    presigned /storage URL (see medplum.py)."""
    docs = medplum.search_resources(
        "DocumentReference",
        {"type": f"{fc.CS_DOC}|health-review", "_sort": "-date", "_count": 1},
    )
    if not docs:
        return None
    doc = docs[0]
    md_url = next(
        (
            c["attachment"]["url"]
            for c in doc.get("content", [])
            if c["attachment"].get("contentType") == "text/markdown"
        ),
        None,
    )
    markdown = medplum.read_attachment(md_url).decode() if md_url else ""
    return {
        "document_reference_id": doc["id"],
        "generated_at": doc.get("date"),
        "description": doc.get("description", ""),
        "markdown": markdown,
    }


def review_pdf(medplum: MedplumFhirClient, doc_id: str) -> bytes:
    """PDF bytes of one review document. KeyError (→ HTTP 400) when the
    document has no PDF attachment."""
    doc = medplum.get(f"DocumentReference/{doc_id}")
    pdf_url = next(
        (
            c["attachment"]["url"]
            for c in doc.get("content", [])
            if c["attachment"].get("contentType") == "application/pdf"
        ),
        None,
    )
    if not pdf_url:
        raise KeyError("no PDF attachment on this review")
    return medplum.read_attachment(pdf_url)
