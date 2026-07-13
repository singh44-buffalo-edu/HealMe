SHELL := /bin/zsh
COMPOSE := docker compose -f infra/docker-compose.yml
PY := ai-service/.venv/bin/python

.PHONY: up down logs dev seed smoke bootstrap install test

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

dev:
	@trap 'kill 0' INT TERM; \
	(cd frontend && npm run dev) & \
	(cd ai-service && .venv/bin/uvicorn app.main:app --reload --port 8000) & \
	wait

smoke:
	$(PY) scripts/smoke_test.py

install:
	cd frontend && npm install
	cd ai-service && python3.12 -m venv .venv && .venv/bin/pip install -q -r requirements.txt

test:
	cd ai-service && .venv/bin/pytest -q
