"""Settings loaded from the repo-root .env (single source of configuration).

Read once at import time into the `settings` singleton; every module takes its
knobs from here rather than os.environ. Secrets live only in .env (gitignored,
keys mirrored in .env.example — CLAUDE.md §6); every field has a default so the
service boots with no .env at all (AI features then show "configure a
provider", Medplum calls fail with a clear "not configured" error).
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# app/config.py → two levels up = repo root. CONTAINER QUIRK: the Docker image
# copies the app to /srv/app, so parents[2] resolves to "/" — paths derived
# from REPO_ROOT (data/secrets, data/inbox) become /data/... inside the
# container, and docker-compose bind-mounts the host folders there (that is
# how `make prod-up` shares AI settings/keys with the host). Keep this in mind
# before moving this file or changing the image's WORKDIR.
REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """Env-var/.env-backed settings. Field names map to UPPER_CASE env vars
    (pydantic-settings); unknown vars in .env are ignored so the frontend's
    VITE_* entries can share the same file."""

    model_config = SettingsConfigDict(
        env_file=str(REPO_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Medplum connection: ClientApplication credentials (created in the app's
    # Project Admin page, see CLAUDE.md §5) + the single owner Patient id
    # written by `make seed`. medplum.py refuses requests until these are set.
    medplum_base_url: str = "http://localhost:8103/"
    medplum_client_id: str = ""
    medplum_client_secret: str = ""
    medplum_patient_id: str = ""

    # Legacy AI env config — superseded by AI Settings (data/secrets/ai-settings.json
    # + keystore) but still honored while that file is absent (ai_settings._effective).
    # Keys set here are the lowest-priority fallback; KeyStore wins (providers.resolve_key).
    ai_provider: str = ""  # anthropic | openai | gemini | ollama | "" (disabled)
    ai_model: str = ""
    anthropic_api_key: str = ""
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"  # custom-endpoint option (proxy/gateway)
    gemini_api_key: str = ""
    ollama_base_url: str = "http://localhost:11434/"

    # CORS allowlist for the React frontend (comma-separated origins).
    ai_allowed_origins: str = "http://localhost:5173"
    # Require a valid Medplum access token on every endpoint except /health
    # (auth.py). Default ON: the service can export the whole record, so an
    # unauthenticated surface is only tolerable on a fully-loopback dev box —
    # set AI_REQUIRE_AUTH=false there if you must.
    ai_require_auth: bool = True
    # Watched-folder ingestion (watcher.py): relative paths resolve against REPO_ROOT.
    ingest_watch_dir: str = "./data/inbox"
    ingest_scan_seconds: int = 60

    # Owner decisions (CLAUDE.md §8): kg units, 24 h clock, 90-day review window.
    # The time zone anchors relative phrases in NL capture ("this morning").
    hmd_time_zone: str = "America/Los_Angeles"
    hmd_weight_unit: str = "kg"
    hmd_clock_format: str = "24h"
    hmd_health_review_days: int = 90


# Import-time singleton: values are frozen at process start (tests monkeypatch
# attributes on this object rather than reloading).
settings = Settings()
