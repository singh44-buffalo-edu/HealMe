"""FastAPI entrypoint (:8000) — the HTTP surface of the ai-service.

Architecture position (CLAUDE.md §2): the React frontend (:5173) calls these
endpoints for everything AI/OCR/ingestion-shaped; all data access goes through
the shared `medplum` client into the CDR (:8103). This module wires CORS, the
watched-folder background loop, and the routes for health checks, Health
Review, exports and ingestion/imports; the /ai (ai_settings.py) and /assistant
(assistant.py) routers are included from their modules.

Conventions:
- `_wrap` maps domain errors onto HTTP: 503 = not configured (drives the
  frontend's "configure a provider" empty state — the app must work with no
  AI key, CLAUDE.md §6), 502 = upstream (provider/Medplum) failed,
  400 = bad input.
- Long blocking pipelines (OCR, model calls, big imports) run via
  run_in_threadpool so the event loop stays responsive.
- Nothing here writes clinical resources directly — writes happen in the
  domain modules, which enforce the review-queue / idempotency invariants.
"""

import asyncio
import json
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from . import ai_settings, assistant, auth, export, health_review, importers, ingest, push, watcher
from .apns import configured as push_apns_configured
from .config import settings
from .medplum import MedplumError, medplum
from .providers import ProviderError, ProviderNotConfigured, provider_status


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Run the data/inbox watcher (watcher.watch_loop) for the app's lifetime;
    cancelled on shutdown. A watcher crash never takes the API down."""
    watch_task = asyncio.create_task(watcher.watch_loop())
    yield
    watch_task.cancel()


app = FastAPI(title="HealMeDaily AI service", version="0.3.0", lifespan=lifespan)

# Session gate (auth.py) registered BEFORE CORSMiddleware is added: Starlette
# treats the last-added middleware as outermost, so CORS must come after this
# for 401/502 responses to still carry CORS headers in the browser.
app.middleware("http")(auth.require_medplum_token)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.ai_allowed_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ai_settings.router)
app.include_router(assistant.router)
app.include_router(push.router)


def _patient_id() -> str:
    """The single owner Patient id (single-user app) — every write is scoped to
    it. 503 until `make seed` has stamped it into .env."""
    if not settings.medplum_patient_id:
        raise HTTPException(status_code=503, detail="MEDPLUM_PATIENT_ID not set — run make seed")
    return settings.medplum_patient_id


def _wrap(fn, *args, **kwargs):
    """Common error → HTTP mapping so AI/Medplum failures surface cleanly."""
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


@app.get("/health")
def health() -> dict:
    """Liveness + configuration snapshot for `make smoke` and the frontend
    banner. Never throws and never touches the network — must answer even on a
    completely unconfigured machine."""
    return {
        "status": "ok",
        "medplum_configured": medplum.configured,
        "auth_required": settings.ai_require_auth,
        "push_configured": push_apns_configured(),
        "ai": provider_status(),
    }


@app.get("/medplum/status")
def medplum_status() -> dict:
    """Round-trip connectivity probe: performs one real Patient search (with
    _total=accurate, since Medplum defaults _total to none). 503 = credentials
    missing, 502 = server unreachable/rejecting."""
    if not medplum.configured:
        raise HTTPException(status_code=503, detail="Medplum client credentials not configured — run make bootstrap")
    try:
        bundle = medplum.search("Patient", {"_count": 1, "_total": "accurate"})
    except MedplumError as err:
        raise HTTPException(status_code=502, detail=str(err)) from err
    return {"connected": True, "patients": bundle.get("total", 0)}


# --- Health Review -----------------------------------------------------------


class HealthReviewRequest(BaseModel):
    window_days: int = 90  # owner default (CLAUDE.md §8); 30/custom selectable in the UI


@app.post("/health-review")
def create_health_review(body: HealthReviewRequest) -> dict:
    """Generate an AI Health Review over the last `window_days` and store it in
    the CDR (DocumentReference + markdown/PDF Binaries). 503 when no provider
    is configured — the review is optional AI, never required."""
    if not 1 <= body.window_days <= 3650:
        raise HTTPException(status_code=400, detail="window_days must be between 1 and 3650")
    return _wrap(health_review.run_health_review, medplum, body.window_days, _patient_id())


@app.post("/health-review/data-summary")
def create_data_summary(body: HealthReviewRequest) -> dict:
    """Deterministic clinician summary — no AI provider required."""
    if not 1 <= body.window_days <= 3650:
        raise HTTPException(status_code=400, detail="window_days must be between 1 and 3650")
    return _wrap(health_review.run_data_summary, medplum, body.window_days, _patient_id())


@app.get("/export/fhir")
def export_fhir() -> Response:
    """Whole-record FHIR collection bundle as a download (data portability,
    spec IR-1). Round-trips through POST /import/fhir."""
    bundle = _wrap(export.export_fhir_bundle, medplum)
    return Response(
        content=json.dumps(bundle, indent=1),
        media_type="application/fhir+json",
        headers={"Content-Disposition": 'attachment; filename="healmedaily-export.fhir.json"'},
    )


@app.get("/export/observations.csv")
def export_csv() -> Response:
    """All Observations as CSV (spec IR-3) — the same column layout that
    POST /import/csv accepts back."""
    csv_text = _wrap(export.export_observations_csv, medplum)
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="healmedaily-observations.csv"'},
    )


@app.get("/health-review/latest")
def get_latest_review() -> dict:
    """Most recent stored review (AI or data-only) with its markdown body;
    404 while none has ever been generated."""
    result = _wrap(health_review.latest_review, medplum)
    if result is None:
        raise HTTPException(status_code=404, detail="no health review generated yet")
    return result


@app.get("/health-review/{doc_id}/pdf")
def get_review_pdf(doc_id: str) -> Response:
    """Download the PDF rendition attached to a review DocumentReference."""
    pdf = _wrap(health_review.review_pdf, medplum, doc_id)
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="health-review.pdf"'},
    )


# --- Ingestion ---------------------------------------------------------------


@app.post("/ingest/upload")
async def upload_document(file: UploadFile = File(...)) -> dict:
    """Upload a PDF/photo into the AI-extraction pipeline (ingest.py): the
    original is stored immutably, extraction proposals land in the review
    queue — nothing commits without owner approval (CLAUDE.md §6)."""
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    if len(data) > 25 * 1024 * 1024:
        # 25 MB cap: generous for scans/photos, keeps base64 vision payloads sane.
        raise HTTPException(status_code=400, detail="file larger than 25 MB")
    patient_id = _patient_id()
    # OCR + model call take tens of seconds — keep them off the event loop.
    return await run_in_threadpool(
        _wrap,
        ingest.ingest_document,
        medplum,
        data,
        file.content_type or "application/octet-stream",
        file.filename or "upload",
        patient_id,
    )


@app.get("/ingest/tasks")
def review_tasks() -> list[dict]:
    """Pending review-queue items (proposal Tasks with their candidate
    resources decoded) for the frontend's Review page."""
    return _wrap(ingest.list_review_tasks, medplum)


@app.post("/ingest/scan-now")
async def scan_now() -> dict:
    """Run one watched-folder scan immediately (also runs every
    INGEST_SCAN_SECONDS in the background)."""
    results = await run_in_threadpool(watcher.scan_once)
    return {"inbox": str(watcher.inbox_dir()), "results": results}


# Deterministic importer kinds (importers.py). Distinct from /ingest/upload:
# these are format conversions of records that already exist elsewhere, so they
# commit directly — the review queue is for AI extractions only (Phase 4 rule).
IMPORT_KINDS = {"fhir", "csv", "apple", "ccda", "hl7"}


@app.post("/import/{kind}")
async def import_structured(kind: str, file: UploadFile = File(...)) -> dict:
    """Deterministic structured imports: FHIR R4 bundle (json), observations
    CSV (this app's export format), Apple Health export.xml, C-CDA document
    (ccda), or HL7v2 ORU results (hl7)."""
    if kind not in IMPORT_KINDS:
        raise HTTPException(status_code=404, detail=f"unknown import kind — one of {sorted(IMPORT_KINDS)}")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    if len(data) > 200 * 1024 * 1024:
        # Apple Health export.xml files reach hundreds of MB — allow far more
        # headroom than document uploads (parsed streaming, not held as base64).
        raise HTTPException(status_code=400, detail="file larger than 200 MB")
    patient_id = _patient_id()
    return await run_in_threadpool(_wrap, importers.run_import, medplum, kind, data, patient_id)


class ApproveRequest(BaseModel):
    # Optional owner-corrected resource; when present it replaces the stored
    # candidate at commit time (human-in-the-loop edit before approval).
    resource: dict[str, Any] | None = None


@app.post("/ingest/tasks/{task_id}/approve")
def approve(task_id: str, body: ApproveRequest) -> dict:
    """Owner approval of one review-queue proposal: $validate gate, then
    commits resource + Provenance + Task completion atomically (FHIR-MAPPING
    §6). 400 when the task is not in 'requested' state (already handled) or
    when the resource fails FHIR validation — the task then stays 'requested'
    so the owner can correct and re-approve."""
    return _wrap(ingest.approve_task, medplum, task_id, body.resource)


@app.post("/ingest/tasks/{task_id}/reject")
def reject(task_id: str) -> dict:
    """Reject a proposal: Task → rejected, no clinical resource is ever
    created. The source document stays in the CDR untouched."""
    _wrap(ingest.reject_task, medplum, task_id)
    return {"task_id": task_id, "status": "rejected"}
