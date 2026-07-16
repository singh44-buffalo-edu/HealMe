# HealMeDaily ai-service image (FastAPI :8000) — built/run by `make prod-up`
# (infra compose). Python 3.12 matches the local brewed venv (CLAUDE.md §4).
#
# Runtime expectations:
# - WORKDIR /srv + COPY app → app/config.py resolves REPO_ROOT to "/", so the
#   service reads/writes /data/... in-container; compose bind-mounts the
#   repo's data/secrets (shared AI settings + BYOK keys — no macOS Keychain
#   here, the 0600-file keystore backend is used) and data/inbox (watcher).
# - Configuration comes from env vars (compose `env_file: .env`) — the image
#   contains no secrets and no .env.
FROM python:3.12-slim

# OCR system dependencies (Tesseract + Poppler for pdf2image) — the container
# twin of `brew install tesseract poppler`, needed for the local (no-cloud)
# extraction path of ingest.extract_text.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

# Dependencies before source: the pip layer stays cached across code edits.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000
# Same probe as `make smoke`'s ai-service step; httpx is already a runtime dep
# so no curl needs installing.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD python -c "import httpx; httpx.get('http://localhost:8000/health', timeout=3).raise_for_status()"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
