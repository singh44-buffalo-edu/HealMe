# HealMeDaily Makefile — the only day-to-day entry points (CLAUDE.md §4).
#
# First-time setup:   make install -> make up -> make bootstrap -> make seed
#                     -> make bots -> make dev  (then `make smoke` to verify)
# Daily loop:         make up + make dev; `make check` before every commit;
#                     `make smoke` before declaring any phase done.
#
# All Python targets use the ai-service venv (create it via `make install`;
# needs brewed python3.12 — system python is too old, CLAUDE.md §4).
SHELL := /bin/zsh
COMPOSE := docker compose -f infra/docker-compose.yml
COMPOSE_ALL := docker compose -f infra/docker-compose.yml -f infra/docker-compose.app.yml
PY := ai-service/.venv/bin/python

.PHONY: up down logs dev seed smoke bootstrap install test lint format check bots prod-up prod-down prod-logs backup

# Start the Medplum stack (postgres/redis/server/app) and block until the
# server is healthy. First boot runs one-time setup — expect minutes.
up:
	$(COMPOSE) up -d
	@echo "Waiting for Medplum server healthcheck (first boot can take minutes)..."
	@until curl -sf http://localhost:8103/healthcheck > /dev/null 2>&1; do sleep 3; printf '.'; done; echo " server up"

# Stop the Medplum stack. Data survives (named postgres volume + binary dir).
down:
	$(COMPOSE) down

# Tail the FHIR server (first stop when a write mysteriously fails).
logs:
	$(COMPOSE) logs -f medplum-server

# One-time: register first user + project, create Patient + ClientApplication, write .env
# Also (re)applies the ai-service least-privilege AccessPolicy — rerun after
# editing SERVICE_POLICY_RESOURCES in scripts/bootstrap.py.
bootstrap:
	$(PY) scripts/bootstrap.py

# Idempotent transaction bundle: Patient, Questionnaires, sample meds/devices/
# data (ifNoneExist — rerun freely; see scripts/seed.py for the fixup story).
seed:
	$(PY) scripts/seed.py

# Build + deploy bots and wire their Subscriptions (idempotent)
# Rerun after ANY backend-bots/src change — deploy is how bot code ships.
bots:
	cd backend-bots && npm install && npm run build
	$(PY) scripts/deploy_bots.py

# Dev loop: Vite frontend :5173 + uvicorn ai-service :8000, both hot-reload,
# one Ctrl-C kills both. Requires the stack (`make up`) for anything useful.
dev:
	@trap 'kill 0' INT TERM; \
	(cd frontend && npm run dev) & \
	(cd ai-service && .venv/bin/uvicorn app.main:app --reload --port 8000) & \
	wait

# End-to-end gate: infra -> auth -> FHIR -> bots -> frontend -> importers.
# Run with stack + dev servers up. A phase is done only when this is green.
smoke:
	$(PY) scripts/smoke_test.py

# Timestamped local backup: Postgres CDR dump + Medplum binary storage -> data/backups/
backup:
	$(PY) scripts/backup.py

# Containerized deployment: Medplum stack + built frontend (:8080) + AI service (:8000).
# Stop `make dev` first — the AI container claims port 8000.
prod-up:
	$(COMPOSE_ALL) up -d --build
	@echo "Waiting for Medplum server healthcheck..."
	@until curl -sf http://localhost:8103/healthcheck > /dev/null 2>&1; do sleep 3; printf '.'; done; echo " server up"
	@until curl -sf http://localhost:8000/health > /dev/null 2>&1; do sleep 2; printf '.'; done; echo " ai-service up"
	@curl -sf -o /dev/null http://localhost:8080 && echo "frontend up at http://localhost:8080"

prod-down:
	$(COMPOSE_ALL) down

prod-logs:
	$(COMPOSE_ALL) logs -f healmedaily-ai healmedaily-web

# All dependencies from scratch (node_modules ×2 + the Python venv).
install:
	cd frontend && npm install
	cd backend-bots && npm install
	cd ai-service && python3.12 -m venv .venv && .venv/bin/pip install -q -r requirements.txt

# All test suites: ai-service pytest, bots vitest, frontend vitest + tsc.
test:
	cd ai-service && .venv/bin/pytest -q
	cd backend-bots && npm test
	cd frontend && npm test
	cd frontend && npx tsc --noEmit

# Static checks only (no tests): ruff, oxlint, bots tsc.
lint:
	ai-service/.venv/bin/ruff check ai-service/app ai-service/tests scripts
	ai-service/.venv/bin/ruff format --check ai-service/app ai-service/tests scripts
	cd frontend && npx oxlint
	cd backend-bots && npm run typecheck

# Auto-format the Python side (ruff). TS/JS is not auto-formatted here.
format:
	ai-service/.venv/bin/ruff format ai-service/app ai-service/tests scripts

# Everything that must be green before a commit: lint + all tests + builds
# (the commit gate from CLAUDE.md §6 — no green, no commit).
check: lint test
	cd frontend && npm run build
	cd backend-bots && npm run build
	@echo "check: all green"

# --- Pi dispenser (Phase 8) — simulator-first, zero hardware needed ---
# pi-sim replays a scripted day (scenarios/day.json) at 60x through the
# simulated HAL without writing to Medplum (--dry-run); pi-test runs its suite.
.PHONY: pi-sim pi-test
pi-sim:
	PYTHONPATH=pi-dispenser $(PY) -m pi_dispenser sim --scenario pi-dispenser/scenarios/day.json --speed 60 --dry-run

pi-test:
	$(PY) -m pytest pi-dispenser/tests -q
