import asyncio
import json
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from . import export, health_review, importers, ingest, watcher
from .config import settings
from .medplum import MedplumError, medplum
from .providers import ProviderError, ProviderNotConfigured, provider_status


@asynccontextmanager
async def lifespan(_: FastAPI):
    watch_task = asyncio.create_task(watcher.watch_loop())
    yield
    watch_task.cancel()


app = FastAPI(title="HealMeDaily AI service", version="0.3.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.ai_allowed_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _patient_id() -> str:
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
    return {
        "status": "ok",
        "medplum_configured": medplum.configured,
        "ai": provider_status(),
    }


@app.get("/medplum/status")
def medplum_status() -> dict:
    if not medplum.configured:
        raise HTTPException(status_code=503, detail="Medplum client credentials not configured — run make bootstrap")
    try:
        bundle = medplum.search("Patient", {"_count": 1, "_total": "accurate"})
    except MedplumError as err:
        raise HTTPException(status_code=502, detail=str(err)) from err
    return {"connected": True, "patients": bundle.get("total", 0)}


# --- Health Review -----------------------------------------------------------


class HealthReviewRequest(BaseModel):
    window_days: int = 90


@app.post("/health-review")
def create_health_review(body: HealthReviewRequest) -> dict:
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
    bundle = _wrap(export.export_fhir_bundle, medplum)
    return Response(
        content=json.dumps(bundle, indent=1),
        media_type="application/fhir+json",
        headers={"Content-Disposition": 'attachment; filename="healmedaily-export.fhir.json"'},
    )


@app.get("/export/observations.csv")
def export_csv() -> Response:
    csv_text = _wrap(export.export_observations_csv, medplum)
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="healmedaily-observations.csv"'},
    )


@app.get("/health-review/latest")
def get_latest_review() -> dict:
    result = _wrap(health_review.latest_review, medplum)
    if result is None:
        raise HTTPException(status_code=404, detail="no health review generated yet")
    return result


@app.get("/health-review/{doc_id}/pdf")
def get_review_pdf(doc_id: str) -> Response:
    pdf = _wrap(health_review.review_pdf, medplum, doc_id)
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="health-review.pdf"'},
    )


# --- Ingestion ---------------------------------------------------------------


@app.post("/ingest/upload")
async def upload_document(file: UploadFile = File(...)) -> dict:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    if len(data) > 25 * 1024 * 1024:
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
    return _wrap(ingest.list_review_tasks, medplum)


@app.post("/ingest/scan-now")
async def scan_now() -> dict:
    """Run one watched-folder scan immediately (also runs every
    INGEST_SCAN_SECONDS in the background)."""
    results = await run_in_threadpool(watcher.scan_once)
    return {"inbox": str(watcher.inbox_dir()), "results": results}


IMPORT_KINDS = {"fhir", "csv", "apple"}


@app.post("/import/{kind}")
async def import_structured(kind: str, file: UploadFile = File(...)) -> dict:
    """Deterministic structured imports: FHIR R4 bundle (json), observations
    CSV (this app's export format), or Apple Health export.xml."""
    if kind not in IMPORT_KINDS:
        raise HTTPException(status_code=404, detail=f"unknown import kind — one of {sorted(IMPORT_KINDS)}")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    if len(data) > 200 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="file larger than 200 MB")
    patient_id = _patient_id()
    return await run_in_threadpool(_wrap, importers.run_import, medplum, kind, data, patient_id)


class ApproveRequest(BaseModel):
    resource: dict[str, Any] | None = None


@app.post("/ingest/tasks/{task_id}/approve")
def approve(task_id: str, body: ApproveRequest) -> dict:
    return _wrap(ingest.approve_task, medplum, task_id, body.resource)


@app.post("/ingest/tasks/{task_id}/reject")
def reject(task_id: str) -> dict:
    _wrap(ingest.reject_task, medplum, task_id)
    return {"task_id": task_id, "status": "rejected"}
