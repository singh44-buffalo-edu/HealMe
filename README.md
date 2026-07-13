# HealMeDaily

Private, single-user personal health record on self-hosted [Medplum](https://www.medplum.com).
Not a certified medical device. Not medical advice — a personal record-keeping and discussion aid.

## Stack

- **Medplum full stack** (Docker: postgres 16, redis 7, server :8103, app :3000) — the FHIR R4 clinical data repository. All clinical data lives here.
- **React frontend** (Vite, `@medplum/react`, Mantine 8) — :5173
- **Python FastAPI service** (AI providers, OCR, ingestion, Health Review) — :8000
- **Medplum Bots** (small FHIR transforms, Subscription-triggered)

Details: [CLAUDE.md](./CLAUDE.md) (architecture + engineering rules) · [FHIR-MAPPING.md](./FHIR-MAPPING.md) (canonical resource map).

## Prerequisites (macOS)

```bash
brew install colima docker docker-compose python@3.12 tesseract poppler
mkdir -p ~/.docker/cli-plugins && ln -sfn "$(brew --prefix)/opt/docker-compose/bin/docker-compose" ~/.docker/cli-plugins/docker-compose
colima start --cpu 4 --memory 6 --disk 60
```

Node 20+ and git assumed. (Docker Desktop works too — anything that provides `docker compose`.)

## First run

```bash
make install     # frontend npm install + ai-service venv
make up          # start Medplum stack; first boot takes minutes
make bootstrap   # one-time: first user + project + service credentials -> .env
make seed        # Patient, check-in Questionnaire, sample meds/cartridges/data
make dev         # frontend :5173 + ai-service :8000
make smoke       # end-to-end smoke test (run while dev is up)
```

Sign in at http://localhost:5173 (and the Medplum admin app at http://localhost:3000) with
`HMD_ADMIN_EMAIL` / `HMD_ADMIN_PASSWORD` from `.env`.

## Day to day

```bash
make up && make dev   # bring everything up
make smoke            # verify end-to-end health
make down             # stop the Medplum stack
make test             # unit tests
make logs             # tail medplum-server logs
```

## Configuration

Copy `.env.example` → `.env` (done automatically by `make bootstrap`). AI features are optional:
leave `AI_PROVIDER` empty and the app runs with AI disabled. Cloud providers receive your health
data (including document contents during ingestion) — a local path (Ollama + Tesseract) is
supported. Data never leaves your machine otherwise.
