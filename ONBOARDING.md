# HealMeDaily — developer onboarding

Welcome. This is a **private, single-user personal health record**: one patient (the owner),
self-hosted, everything on the owner's machine. Read this file first, then `CLAUDE.md`
(engineering source of truth) and `FHIR-MAPPING.md` (canonical data model). Nothing in this
repo is a certified medical device; the app organizes and displays — it never advises.

## The one-paragraph mental model

All clinical data lives in a self-hosted **Medplum** FHIR R4 server (Docker). A custom
**React frontend** talks to it directly for reads/writes. A **Python FastAPI service**
(`ai-service`) handles anything heavy or AI-shaped: document extraction, structured imports,
the Health Review summary, the record-grounded Assistant, BYOK provider management.
**Bots** (small TypeScript functions inside Medplum) react to data events. A **Raspberry Pi
dispenser** package mirrors the app's dose model over the LAN. There is **no side
database** — if it's a health fact, it's a FHIR resource.

```
React app (5173/8080) ──FHIR──▶ Medplum (8103, app UI 3000) ◀──FHIR── pi-dispenser (LAN)
        │                          ▲    └─ Bots (in-server)
        └────HTTP────▶ ai-service (8000) ──FHIR/OAuth2──┘
                          └─▶ AI providers (Ollama local / BYOK cloud, per-feature routing)
```

## Repo map — where to start reading

| Path | What it is | Start with |
| --- | --- | --- |
| `frontend/` | Vite + React 19 + Mantine 8 + `@medplum/react` | `src/App.tsx` (shell), `src/fhir.ts` (dose model), `src/api.ts` (ai-service client) |
| `frontend/src/components/ds.tsx` | Design-system primitives (single source of styling) | its header comment |
| `ai-service/app/` | FastAPI service | `main.py` (routes), `medplum.py` (FHIR client), `providers.py` (AI adapters) |
| `backend-bots/src/` | Medplum bots (subscriptions/cron) | `questionnaire-response-to-observations.ts` |
| `pi-dispenser/` | Dispenser package, simulator-first | `README.md`, then `pi_dispenser/agent.py` |
| `scripts/` | Ops: `bootstrap.py`, `seed.py`, `deploy_bots.py`, `care_circle.py`, `backup.py`, `smoke_test.py` | `smoke_test.py` (what "working" means) |
| `infra/` | Docker compose (Medplum stack + app overlay) | file header comments |
| `personal-health-record-system 2/project/design_handoff_healmedaily/` | Canonical UI designs (`.dc.html`) | its `README.md` |

## Run it

```bash
make up         # Medplum stack (first boot takes minutes)
make bootstrap  # one-time: first user, project, service credentials → .env
make seed       # idempotent sample data (patient, meds, cartridges, dispenser…)
make bots       # build + deploy bots (reminders bot runs on a 15-min cron)
make dev        # frontend :5173 + ai-service :8000 (reload)
make smoke      # end-to-end proof; exits non-zero on failure
make check      # full gate: ruff + oxlint + pytest + vitest + tsc + builds
make pi-sim     # dispenser simulator: one accelerated day, dry-run
```

**A change is done only when `make check` and `make smoke` are green.** Watch out: if the
prod overlay is running (`make prod-up`), **:8000 is the container**, not your dev uvicorn —
stale-container confusion looks like missing routes.

## The five invariants (memorize these)

1. **Review-queue gate** — nothing AI/OCR-extracted enters the record without explicit
   approval (`Task` intent=proposal → approve commits resource + `Provenance` atomically).
   Deterministic importers (FHIR/CSV/Apple/C-CDA/HL7v2) bypass the queue *by design* but
   dedup on content-hash identifiers, so re-imports are no-ops.
2. **One logical dose event** — slot identity is `{request-slug}-{date}T{HH:MM}` everywhere
   (frontend `fhir.ts`, `seed.py`, `pi-dispenser/schedule.py`). No log ⇒ no resource;
   "missed" is never persisted from elapsed time alone.
3. **Three data classes stay unmistakable** — measured = ink, live device = green + pulse,
   AI-derived = indigo + `✦ AI` pill + confidence. AI output never renders unlabeled;
   indigo never appears on non-AI content.
4. **Privacy boundary is loud** — local processing = green "stays home"; anything leaving
   the machine = amber, names the recipient, and writes an `AuditEvent` to the boundary
   ledger *before* the call. BYOK keys live in the OS keychain / `data/secrets/` (0600),
   never in FHIR, never in git.
5. **No clinical advice** — summaries organize, never diagnose or dose; concerning patterns
   are framed "to discuss with your clinician"; vitals thresholds are deliberately not
   hardcoded (set with a clinician).

## Sharp edges (each cost us a debugging session)

- Medplum transaction bundles are **not all-or-nothing** on validation errors — check every
  entry's `response.status` (see `seed.py`).
- `Attachment.url` is rewritten to presigned URLs unusable inside the compose network —
  read binaries via `medplum.read_attachment` server-side.
- FHIR `time` values need seconds (`09:00:00`, never `09:00`).
- Bot subscriptions **never retry** — every bot must be idempotent (`ifNoneExist`).
- The ai-service runs under a least-privilege AccessPolicy — new service-side writes need a
  policy entry in `scripts/bootstrap.py` or they 403.
- Inside the ai container `REPO_ROOT` resolves to `/` → secrets mount at `/data/secrets`.
- Auth-code exchange requires PKCE; "Missing verification context" means you forgot it.

## Care circle & sharing

Sharing has exactly one mechanism: `AccessPolicy` bound via `ProjectMembership.access`.
`scripts/care_circle.py` mints scoped read-only policies (caretaker / alerts-only /
time-boxed clinician share). Break-glass = a bot that swaps a member to a 24h read-all
policy, notifies the owner, and writes a permanent `AuditEvent`. The frontend Access
Control page edits the same policies live.

## Mobile

Responsive PWA (`useIsMobile` + `MobileTabBar`), installable on iOS/Android from the
browser. Native wrappers are deliberately deferred (owner decision on store toolchains).

## Deliberately not built (don't "fix" these)

Auto-commit of extractions · dosing advice or interaction logic · vitals thresholds ·
diet/goal-weight framing · fake data for screens whose backend doesn't exist yet
(live CGM tile, AI forecast cones, dispenser camera UI) — the designs for those live in the
handoff folder and get adopted when their backends arrive.
