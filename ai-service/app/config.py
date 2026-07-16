"""Settings loaded from the repo-root .env (single source of configuration)."""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(REPO_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    medplum_base_url: str = "http://localhost:8103/"
    medplum_client_id: str = ""
    medplum_client_secret: str = ""
    medplum_patient_id: str = ""

    ai_provider: str = ""  # anthropic | openai | gemini | ollama | "" (disabled)
    ai_model: str = ""
    anthropic_api_key: str = ""
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"  # custom-endpoint option (proxy/gateway)
    gemini_api_key: str = ""
    ollama_base_url: str = "http://localhost:11434/"

    ai_allowed_origins: str = "http://localhost:5173"
    ingest_watch_dir: str = "./data/inbox"
    ingest_scan_seconds: int = 60

    hmd_time_zone: str = "America/Los_Angeles"
    hmd_weight_unit: str = "kg"
    hmd_clock_format: str = "24h"
    hmd_health_review_days: int = 90


settings = Settings()
