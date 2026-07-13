# HealMeDaily delivery tracker

Last updated: 2026-07-13

## Phase 1 — design proposal

- [x] Read the current Medplum AI-assistant guidance first.
- [x] Review the Section 15 Medplum documentation and reference applications.
- [x] Audit repository and local prerequisites.
- [x] Write `codex.md`.
- [x] Write `FHIR-MAPPING.md`.
- [x] Commit a safe `.env.example` contract.
- [ ] Owner reviews the proposed defaults, FHIR mapping, and safety semantics.
- [ ] Owner confirms Phase 2 may begin.

## Phase 2 — walking skeleton

- [ ] Install/verify Docker, Python 3.11+, Tesseract, and Poppler.
- [ ] Fetch the official full-stack Compose file, pin Medplum 5.1.24, and narrow CORS.
- [ ] Implement the Makefile operating contract.
- [ ] Start Medplum and complete one-time project setup.
- [ ] Create/configure the Patient and Python ClientApplication AccessPolicy.
- [ ] Scaffold and run the React login/Patient hello.
- [ ] Scaffold and run FastAPI health and Medplum connectivity.
- [ ] Implement idempotent seed.
- [ ] Implement end-to-end smoke test, including transaction behavior.
- [ ] Prove `make up`, `make seed`, `make dev`, and `make smoke`.
- [ ] Build, test, document, commit, and stop for sign-off.

## Later phases

- [ ] Phase 3: runnable MVP.
- [ ] Phase 4: ingestion depth.
- [ ] Phase 5: more dashboards.
- [ ] Phase 6: question engine.
- [ ] Phase 7: AI depth and remaining providers.
- [ ] Phase 8: hardware.
- [ ] Phase 9: hardening and recovery.

