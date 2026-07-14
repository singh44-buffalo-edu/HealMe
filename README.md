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
make install     # frontend + bots npm install, ai-service venv
make up          # start Medplum stack; first boot takes minutes
make bootstrap   # one-time: first user + project + service credentials -> .env
make seed        # Patient, check-in Questionnaire, sample meds/cartridges/data
make bots        # build + deploy the check-in bot and its Subscription
make dev         # frontend :5173 + ai-service :8000
make smoke       # 10-step end-to-end smoke test (run while dev is up)
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

## What the app does (MVP)

- **Adherence dashboard** — one-tap taken/skip/missed per scheduled dose, overdue + critical-med
  alerts, 13-week calendar heatmap, adherence % + streak, per-medication bars, low-stock warnings.
- **Health overview** — weight/mood/energy/sleep charts, recent symptoms, labs with reference
  ranges, latest check-in, at-a-glance summary line.
- **Daily check-in** — FHIR Questionnaire; a Medplum Bot fans numeric answers out to Observations.
- **Quick add** — weight, sleep, mood & energy, symptoms; backdating supported.
- **Cartridges** — medication↔cartridge mapping with capacity/stock/threshold and refill logging
  (the future pill dispenser consumes this mapping unchanged).
- **Documents** — upload PDFs/photos; AI proposes FHIR resources into a review queue; nothing
  joins the record until you approve (committed with Provenance).
- **AI Health Review** — grounded summary of a 30/90-day window with PDF export for clinic visits.
- **More dashboards** — Trends (30d/90d/1y windows), Vitals (BP/HR/temp/SpO2/glucose), Labs
  (per-analyte trends vs reference ranges), Symptoms-vs-medication timeline, Correlations
  (any two metrics, Pearson r, association-not-causation framing), and a check-in explorer.
- **Clinician summary without AI** — a deterministic data-only summary (meds + adherence,
  measurements, labs, symptoms, your saved questions for the prescriber) generates with zero AI
  keys, alongside the AI review.
- **Own your data** — one-click export of the complete record as a FHIR R4 bundle or
  observations CSV.

## Containerized deployment

```bash
make prod-up     # builds + runs everything in Docker: Medplum stack,
                 # frontend (nginx) at http://localhost:8080, AI service at :8000
make prod-logs   # tail the app containers
make prod-down   # stop everything
```

`make dev` and `make prod-up` both claim port 8000 — run one at a time. Bootstrap/seed/bots
are host-run one-time steps (`make bootstrap && make seed && make bots`) and work against
either mode.

## Configuration

Copy `.env.example` → `.env` (done automatically by `make bootstrap`). AI features are optional:
leave `AI_PROVIDER` empty and the app runs with AI disabled. To enable: set
`AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY=...`, then restart `make dev`. Cloud providers
receive your health data (including document contents during ingestion) — a local path
(Ollama + Tesseract) is planned. Data never leaves your machine otherwise.
