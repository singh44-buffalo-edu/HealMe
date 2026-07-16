SHELL := /bin/zsh
COMPOSE := docker compose -f infra/docker-compose.yml
COMPOSE_ALL := docker compose -f infra/docker-compose.yml -f infra/docker-compose.app.yml
PY := ai-service/.venv/bin/python

.PHONY: up down logs dev seed smoke bootstrap install test lint format check bots prod-up prod-down prod-logs backup

up:
	$(COMPOSE) up -d
	@echo "Waiting for Medplum server healthcheck (first boot can take minutes)..."
	@until curl -sf http://localhost:8103/healthcheck > /dev/null 2>&1; do sleep 3; printf '.'; done; echo " server up"

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f medplum-server

# One-time: register first user + project, create Patient + ClientApplication, write .env
bootstrap:
	$(PY) scripts/bootstrap.py

seed:
	$(PY) scripts/seed.py

# Build + deploy bots and wire their Subscriptions (idempotent)
bots:
	cd backend-bots && npm install && npm run build
	$(PY) scripts/deploy_bots.py

dev:
	@trap 'kill 0' INT TERM; \
	(cd frontend && npm run dev) & \
	(cd ai-service && .venv/bin/uvicorn app.main:app --reload --port 8000) & \
	wait

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

install:
	cd frontend && npm install
	cd backend-bots && npm install
	cd ai-service && python3.12 -m venv .venv && .venv/bin/pip install -q -r requirements.txt

test:
	cd ai-service && .venv/bin/pytest -q
	cd backend-bots && npm test
	cd frontend && npm test
	cd frontend && npx tsc --noEmit

lint:
	ai-service/.venv/bin/ruff check ai-service/app ai-service/tests scripts
	ai-service/.venv/bin/ruff format --check ai-service/app ai-service/tests scripts
	cd frontend && npx oxlint
	cd backend-bots && npm run typecheck

format:
	ai-service/.venv/bin/ruff format ai-service/app ai-service/tests scripts

# Everything that must be green before a commit: lint + all tests + builds
check: lint test
	cd frontend && npm run build
	cd backend-bots && npm run build
	@echo "check: all green"

# --- Pi dispenser (Phase 8) — simulator-first, zero hardware needed ---
.PHONY: pi-sim pi-test
pi-sim:
	PYTHONPATH=pi-dispenser $(PY) -m pi_dispenser sim --scenario pi-dispenser/scenarios/day.json --speed 60 --dry-run

pi-test:
	$(PY) -m pytest pi-dispenser/tests -q
