from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .medplum import MedplumError, medplum

app = FastAPI(title="HealMeDaily AI service", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.ai_allowed_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "medplum_configured": medplum.configured,
        "ai_provider": settings.ai_provider or None,
    }


@app.get("/medplum/status")
def medplum_status() -> dict:
    """Prove client-credentials auth + a FHIR read end-to-end."""
    if not medplum.configured:
        raise HTTPException(status_code=503, detail="Medplum client credentials not configured — run make bootstrap")
    try:
        bundle = medplum.search("Patient", {"_count": 1, "_total": "accurate"})
    except MedplumError as err:
        raise HTTPException(status_code=502, detail=str(err)) from err
    return {"connected": True, "patients": bundle.get("total", 0)}
