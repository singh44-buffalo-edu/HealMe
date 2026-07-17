# CLAUDE.md — HealMeDaily personal EHR

Living source of truth for building this project. If this file disagrees with the official Medplum docs, **the docs win** — then update this file.

## 1. What this is

A private, **single-user** EHR web app on **self-hosted Medplum**. One patient (the owner). Features: medication intake & adherence logging, periodic health check-ins, sleep/weight/symptoms/mood tracking, ingestion of existing medical records (PDFs, prior EHR exports), cartridge configuration (for a future pill-dispenser), custom dashboards (adherence first), and an AI health summary for medical reviews.

**The one rule: make it run.** Every phase must end with a bootable system. Walking skeleton first, features second. When in doubt, choose the simpler thing that runs.

Not a certified medical device. Not medical advice. Human-in-the-loop for all AI/OCR-extracted data — never auto-commit. No clinical advice logic anywhere.

## 2. Architecture

```
  React frontend (Vite + @medplum/core + @medplum/react + Mantine 8)   :5173
            │  FHIR REST / GraphQL  (MedplumClient, MedplumProvider)
            ▼
  ┌──────────────── Medplum (self-hosted, Docker) ─────────────────┐
  │  medplum-app :3000   medplum-server :8103                       │
  │  Auth (OAuth/SMART) · FHIR R4 API · CDR                         │
  │  Bots (vmcontext) · Subscriptions · Postgres :5432 · Redis :6379│
  └──────────▲──────────────────────────────────────────────────────┘
             │  FHIR REST + OAuth2 client credentials (ClientApplication)
  Python FastAPI service  :8000  ← pluggable AI providers, OCR/vision
                                   extraction, Health Review, heavy ingestion
```

- **Data layer** = Medplum's official full-stack Docker (postgres 16, redis 7, medplum-server, medplum-app). **All clinical data lives in the FHIR CDR. No side database.**
- **Frontend** = fresh custom React app (not a fork), `@medplum/react` + Mantine, wrapped in `MedplumProvider`. Built-in Medplum App at :3000 is the admin/data-inspection tool — never rebuild admin.
- **Bots** (TypeScript, in `/backend-bots`) = small, pure FHIR transforms triggered by Subscriptions (e.g. QuestionnaireResponse → Observations).
- **Python FastAPI service** (`/ai-service`) = AI providers, OCR/vision, Health Review, heavy ingestion. Auths via OAuth2 client credentials; talks FHIR REST with httpx.
- **Rule of thumb:** small FHIR transform → Bot; AI/OCR/LLM/PDF → Python service; UI/dashboards → React app.

### Repo layout
```
/frontend       Vite React app
/ai-service     FastAPI service (.venv, app/ package)
/backend-bots   Bot sources + medplum.config.json (bots array)
/scripts        seed.py, smoke_test.py, helpers
/infra          docker-compose.yml (Medplum full stack)
/data           local runtime data (gitignored): inbox/ watched folder
/ios            native SwiftUI iPhone app (2026-07-16): HealMeDailyKit SwiftPM
                data core (DoseEngine = behavioral twin of frontend/src/fhir.ts;
                its tests mirror fhir.test.ts — change both in lockstep) +
                HealMeDaily app target (XcodeGen project.yml, .xcodeproj
                gitignored). make ios-project / ios-test / ios-build; docs:
                ios/README.md + APPSTORE.md. 2026-07-17: offline write outbox
                + core snapshot (Sync.swift), opt-in read-only HealthKit sync
                (HealthKitMapping + HealthKitService, identifier suffix
                `healthkit` — mapping §7), Labs/Trends/Profile screens,
                SwiftLint/SwiftFormat + CI ios job. ai-service requires a
                Medplum bearer token on all endpoints except /health
                (AI_REQUIRE_AUTH, web+iOS forward it automatically).
/personal-health-record-system 2/project/design_handoff_healmedaily/   design handoff (canonical UI reference)
CLAUDE.md  FHIR-MAPPING.md  APPSTORE.md  Makefile  .env  .env.example
```

### Design system (adopted 2026-07-15 from the Claude-design handoff)
The `.dc.html` files in the handoff folder above are the **canonical UI reference** (its `README.md` = token tables, `HealMeDaily Design System v2.dc.html` = component catalog). Frontend implementation:
- **Tokens**: `frontend/src/theme.css` (CSS vars) + `frontend/src/tokens.ts` (`T`, `mono()` for JS/SVG) + `frontend/src/theme.ts` (Mantine theme: `hmdGreen/hmdIndigo/hmdRed/hmdAmber` scales). IBM Plex Mono is bundled via `@fontsource/ibm-plex-mono` — never load fonts from a CDN (privacy promise: nothing leaves the device).
- **Primitives**: `frontend/src/components/ds.tsx` — DsCard, PageHeader, Eyebrow, StatusDot, AIPill, Chip, VaultChip, BoundaryRow, SegmentedPills, FilterChips, PillButton, ConfidenceBar, Heatstrip, Sparkline, StatusStrip, TableRow, DateBadge. Extend here, don't fork styles in pages.
- **Non-negotiable rules**: three data classes stay unmistakable — measured = ink, live device = green + `hmdPulse` dot, AI-derived = indigo + `✦ AI` pill + confidence (never render AI output unlabeled; never use indigo on non-AI content). Cards are borderless on soft shadow (hairline dividers inside only). Status color lives on values/dots, never floods a card. Numbers/units/timestamps/codes = IBM Plex Mono. Metric hues (incl. canonical `T.metric.mood`/`T.metric.energy`) color data only, never chrome. VaultChip ("On this device") on every surface; cloud boundaries always amber + named recipient (BoundaryRow).
- Design screens with no backend yet (live CGM tile, dispenser trays, AI forecasts, caretaker/access-control, assistant chat, mobile) are **deliberately not faked** — build the backend first, then adopt the corresponding `.dc.html`.

## 3. FHIR resource map

**[FHIR-MAPPING.md](./FHIR-MAPPING.md) is canonical — read it before touching any resource shape.** Do not duplicate its details here; this is only the orientation summary:

- One `Patient`. Meds: `Medication` + `MedicationRequest` (SIG kept in `dosageInstruction.text`; life-critical flag via `medicationrequest-life-critical` extension, owner-set only).
- Dose log: `MedicationAdministration` — `completed`, or `not-done` + `statusReason` (`user-skipped` / `user-marked-missed`). **No log ⇒ no resource**; dashboards compute due/overdue from the schedule. Skipped→taken updates the same logical event (stable identifier = request + scheduled occurrence; PRN = client event UUID).
- Check-ins: `Questionnaire` → `QuestionnaireResponse` → Bot fans selected answers out to `Observation`s (`derivedFrom`, identifier = responseId+linkId). Bot strategy, not SDC extraction.
- Trackers/symptoms: `Observation` (verified codes only, else local; symptom↔med link via `Observation.focus`, user-asserted, never inferred). Enduring problems: `Condition`.
- Ingestion: original → `DocumentReference` + `Binary` (`securityContext` → Patient, never `Attachment.data`); each candidate → proposal `Binary` (fhir+json) + `Task` (intent=proposal); confirm = one transaction (create resource + `Provenance` + Task completed). AI/OCR never bypasses the gate.
- Cartridges: `Device` (type `medication-cartridge`, `device-assigned-medication` extension, `Device.property` for capacity/remaining-count/low-stock-threshold; **no `Device.patient`** — R4 means affixed-to-body). Refill: `SupplyDelivery` + Device update in one transaction; decrement uses `ifMatch`. Inventory never gates whether a med may be taken. Dispenser later = parent `Device`.
- Health Review output: `DocumentReference` + `Binary` PDF (local type `health-review`).
- Identifier systems: `https://healmedaily.local/fhir/identifier/<suffix>` · CodeSystems + extensions under `https://healmedaily.local/fhir/…` (see mapping §1). **Never invent LOINC/SNOMED/RxNorm codes** — verified only, else local code + raw text.

Coding system URLs: RxNorm `http://www.nlm.nih.gov/research/umls/rxnorm` · SNOMED `http://snomed.info/sct` · LOINC `http://loinc.org` · UCUM `http://unitsofmeasure.org`.

## 4. Run / test commands

```bash
make up      # docker compose -f infra/docker-compose.yml up -d   (first boot: minutes — wait for healthcheck)
make down    # stop stack
make dev     # frontend :5173 + ai-service :8000 (reload)
make seed    # python scripts/seed.py  → transaction Bundle: Patient, Questionnaires, Meds, Devices, sample data
make smoke   # python scripts/smoke_test.py  → exits non-zero on failure
```

Health checks: `curl -sf http://localhost:8103/healthcheck` (server) · `curl -sf http://localhost:8000/health` (ai-service) · app at http://localhost:3000 · frontend at http://localhost:5173.

Smoke test sequence: server healthcheck → ai-service /health → OAuth token → read Patient → write test Observation → read it back → frontend responds.

Tests: `cd backend-bots && npm test` (vitest + `@medplum/mock` MockClient) · `cd ai-service && .venv/bin/pytest`.

**A phase is done only when: builds, starts, smoke passes.** Never advance on red.

### Ports
app **:3000** · server **:8103** · Vite **:5173** · FastAPI **:8000** · Postgres **:5432** · Redis **:6379** · Ollama (optional) **:11434**

### macOS notes (this machine)
- Homebrew present. Docker + Python 3.11+ + tesseract/poppler must come from brew (no apt-get):
  `brew install --cask docker` (or colima) · `brew install python@3.12 tesseract poppler`
- Always create the venv with the brewed python: `python3.12 -m venv .venv` (system python is 3.9 — too old).

## 5. Medplum facts (verified against docs, 2026-07)

### Versions (pin these)
- `@medplum/core` / `@medplum/react` / `@medplum/fhirtypes` / `@medplum/cli` **5.1.26**
- `@medplum/react@5.x` peer-requires **Mantine ^8** (`@mantine/core @mantine/hooks @mantine/notifications @mantine/spotlight` — install all four, ^8.3). Docs pages saying "Mantine v7" are stale; npm peerDependencies win. React 18 or 19.
- Docker images: pin `medplum/medplum-server` + `medplum/medplum-app` to the current release tag instead of `latest` (edit compose file at skeleton time; upgrade deliberately per Upgrading-Server doc).

### Full-stack Docker
- Compose source: `https://raw.githubusercontent.com/medplum/medplum/refs/heads/main/docker-compose.full-stack.yml`
- Ships preconfigured: `MEDPLUM_BASE_URL=http://localhost:8103/`, `MEDPLUM_APP_BASE_URL=http://localhost:3000/`, `MEDPLUM_ALLOWED_ORIGINS='*'` (CORS already open for dev — tighten to explicit origins in hardening), `MEDPLUM_VM_CONTEXT_BOTS_ENABLED='true'`, `MEDPLUM_DEFAULT_BOT_RUNTIME_VERSION='vmcontext'`, `MEDPLUM_BINARY_STORAGE='file:./binary/'`, postgres user/pass `medplum`/`medplum`.
- Server config via env vars uses prefix `MEDPLUM_`; local file alternative `medplum.config.json`.
- First boot does one-time setup before healthcheck passes — **wait minutes, don't panic**.
- First user: register at http://localhost:3000 (`registerEnabled` defaults true; disable in hardening). That user becomes admin of the first Project. Super-admin panel: `/admin/super`. **Never touch super-admin "Purge/Rebuild/Reindex" buttons casually — irreparable.**

### Auth (Python service)
- Create `ClientApplication` in the app's Project Admin page → id + secret → `.env`.
- `POST {base}/oauth2/token` with `grant_type=client_credentials&client_id&client_secret` → `{access_token, expires_in: 3600}`. Cache token; refresh on 401. TS SDK equivalent: `medplum.startClientLogin(id, secret)`.
- Scope it with an `AccessPolicy` bound via `ProjectMembership.access[]` (hardening phase; note until then). AccessPolicy criteria supports only `:not`/`:missing` modifiers, no chained search.

### Bots
- Handler: `export async function handler(medplum: MedplumClient, event: BotEvent): Promise<any>` from `@medplum/core`. `event.input` = triggering resource.
- **Bots must be enabled per project** (project settings/features) even though the server has vmcontext enabled.
- CLI (auth via `MEDPLUM_BASE_URL` + `MEDPLUM_CLIENT_ID`/`MEDPLUM_CLIENT_SECRET` env, or `medplum login`):
  - `npx medplum bot create <name> <project id> <source file> <dist file>`
  - `npx medplum bot save <name>` (upload code) · `npx medplum bot deploy <name>` (activate)
  - Config: `medplum.config.json` → `bots: [{name, id, source, dist}]`. Old `deploy-bot`/`save-bot` forms are deprecated.
- Trigger via `Subscription`: `status=active`, `criteria` = FHIR search string (e.g. `QuestionnaireResponse?status=completed`), `channel: {type: 'rest-hook', endpoint: 'Bot/<id>', payload: 'application/fhir+json'}`.
- ⚠️ **Bot-endpoint subscriptions execute once, never retry.** Bots must be idempotent AND non-critical to data integrity (a missed run must be recoverable — e.g. re-runnable over history).
- Useful extensions (copy URLs exactly): FHIRPath criteria `https://medplum.com/fhir/StructureDefinition/fhir-path-criteria-expression` (`%previous`/`%current`); interaction filter `…/subscription-supported-interaction` valueCode create|update|delete (one only).
- Unit test with `MockClient` from `@medplum/mock`.

### Search (Medplum specifics)
- `_count` default **20**, max **1000**; `_offset` max 10 000; `_total` default `none` (ask `accurate` when you need Bundle.total).
- Paginate with `Bundle.link.next` or SDK `medplum.searchResourcePages(type, params)` (async generator); `searchResources` returns typed array.
- `_include=Type:param`, `_revinclude`, `_sort=-_lastUpdated`, date prefixes `ge/le/gt/lt`, reverse chain `_has:`. Chained search is REST-only (not GraphQL).
- Never fetch-all-and-filter-in-JS. Typed params + server-side filtering always.

### React
- Required CSS imports (else components render broken): `@mantine/core/styles.css` + `@medplum/react/styles.css`.
- PostCSS: `postcss-preset-mantine` + `postcss-simple-vars` (mantine breakpoints) in `postcss.config.mjs`.
- Wiring: `MedplumClient({baseUrl})` → `<MedplumProvider medplum={medplum}><MantineProvider>…`. Components: `SignInForm`, `QuestionnaireForm` (onSubmit yields QuestionnaireResponse), `ResourceTable`, timelines — check Storybook before hand-rolling.
- `getQuestionnaireAnswers(response)` from `@medplum/core` → answers keyed by `linkId`.
- Vite env vars must be `VITE_`-prefixed, baked at build time.

## 6. Conventions

- **Idempotent writes everywhere a retry/replay can happen**: stable business identifiers + conditional create/update (`If-None-Exist`, `ifMatch` version checks for read-modify-write like cartridge decrements). Identifier table: FHIR-MAPPING.md §7.
- **Multi-resource writes = transaction Bundle** (`POST {base}fhir/R4` with `Bundle.type=transaction`): seeding, ingestion commits, dispense+decrement.
- **Timestamps**: clinical time in `effectiveDateTime`/`authored` (backdating supported in every log UI); record time via `meta.lastUpdated`/`_history`.
- **TypeScript**: `@medplum/fhirtypes` everywhere; `tsc --noEmit` must pass. Bots small + pure.
- **Python**: FastAPI, httpx, pydantic; format/lint with ruff; pytest for logic. Token cache with 401 retry-once.
- **Secrets**: `.env` only (gitignored), keys mirrored in `.env.example`. Never in code, never committed. App must boot with **no AI key** — AI features show "configure a provider" state.
- **AI guardrails (non-negotiable)**: summaries organize, never diagnose/prescribe; concerning patterns framed "to discuss with your clinician"; disclaimer on every summary + PDF ("Not medical advice — a discussion aid; review with a qualified clinician"); never send data to an unconfigured provider; cloud-provider data flow disclosed in UI; local path (Ollama + Tesseract) offered; sustained serious distress in mental-health content → gently surface professional/crisis resources, no alarmism.
- **Ingestion**: nothing auto-commits. Proposed resources ride a `Task` review queue; approval commits resource + `Provenance` atomically. Source `DocumentReference`/`Binary` immutable.
- **Neutral weight framing**: no diet targets/goal weight/calorie logic by default; goals opt-in only.
- **Git**: commit at end of each phase; conventional-ish messages; never commit secrets or `data/`. **`make check` must be green before any commit** (ruff + oxlint + pytest + vitest ×2 + tsc + builds); `make smoke` before ending a phase.
- **Ask the owner before**: changing the FHIR data model post-MVP, adding heavy deps, anything touching medical-safety behavior (auto-commit of extractions, adherence/dose logic changes).

## 7. Phase plan & status

| # | Phase | Status |
|---|---|---|
| 1 | Design proposal + CLAUDE.md + FHIR-MAPPING.md | ✅ awaiting sign-off |
| 2 | Walking skeleton: 3 tiers up + seeded + smoke green | — |
| 3 | MVP: logging UI, cartridge config, 2 dashboards (Adherence, Health Overview), QR→Obs Bot, AI Health Review + PDF, basic ingestion w/ review queue | ✅ |
| 4 | Ingestion depth: FHIR-bundle/CSV/Apple-Health importers (deterministic, dedup by content-hash identifier, `imported` tag + Provenance, direct commit — review queue is for AI extractions only), watched folder `data/inbox` (60s scan + `/ingest/scan-now`, processed/failed archive). 2026-07-15: + C-CDA (stdlib XML, verified-OID code systems only) and HL7v2 ORU (ER7, DiagnosticReport per OBR) importers; NL quick capture (`/assistant/nl-import`) proposes via the review queue | ✅ |
| 5 | More dashboards: trends, symptom-vs-med timeline, labs, explorer (✅ pulled forward); correlations | partial ✅ |
| 6 | Question engine: cadence-tagged questionnaire bank (D/W/M), due engine + multi-check-in UI, symptom→follow-up-Task bot, home due-panel. Remaining: more bank domains (spec §12), adaptive cadence, PHQ/GAD screenings | mostly ✅ |
| 7 | More AI (2026-07-15): all 4 providers live (Anthropic/OpenAI/Gemini via httpx + Ollama local), BYOK keystore (macOS Keychain, 0600 file fallback in `data/secrets/`, keys never in FHIR/env dumps), per-feature routing local\|cloud\|off (`/ai` endpoints + AI Settings page), boundary-ledger AuditEvent before every cloud call, record-grounded Assistant with mandatory citations (`/assistant`, sessions = deletable Communications), NL quick capture. Remaining: PDF polish, ask-data chat streaming | mostly ✅ |
| 8 | Hardware (2026-07-15): `pi-dispenser/` package sim-first — HAL (spindle/load-cell/chime/camera) with simulated+GPIO backends, scheduler shares the app's dose-event identity, MedicationDispense→Administration w/ `administration-verification` (weight>camera>self), escalation ladder per Dose Ritual design, `make pi-sim`/`pi-test`, systemd unit. Remaining: real-hardware bring-up (servo/load-cell calibration, picamera), dispenser ClientApplication, voice check-ins, Pi dashboard | partial ✅ |
| 9 | Hardening: ai-service least-privilege AccessPolicy (bootstrap, applied), care circle (`scripts/care_circle.py` — scoped read-only AccessPolicies per member, clinician shares w/ expiry), break-glass bot (24h + owner notify + permanent AuditEvent), reminders-runner cron bot (15min, CommunicationRequest only), `scripts/backup.py` + `make backup`, Access Control + History pages. registerEnabled=false active in compose (flip to true once for a fresh install's `make bootstrap`), `make rotate-superadmin` script ready (owner runs it deliberately). Remaining: actually rotating the super-admin password, encryption-at-rest, pin/upgrade discipline (containerize ✅: `make prod-up` → frontend :8080, ai-service :8000, `data/secrets` mounted for shared AI settings) | mostly ✅ |

Pause for owner confirmation after each phase. Every phase ends runnable (`make up/dev/seed/smoke` green).

## 8. Decisions (owner-confirmed 2026-07-13)

- **AI keys available: Anthropic only.** MVP wires the Anthropic adapter; OpenAI/Gemini/Ollama adapters in Phase 7. Never send data to an unconfigured provider.
- **Privacy: choose per run.** Health Review + ingestion each show a provider picker; cloud clearly labeled ("data incl. document contents leaves this machine"), local (Ollama + Tesseract) path always offered even before Ollama is set up (shown as "not configured" until then).
- **Data formats: all of them, eventually** — manual entry + PDFs/photos (MVP slice), FHIR bundle exports, C-CDA/HL7/CSV, Apple Health/Health Connect (Phase 4 importers). MVP ingestion targets PDFs/photos first.
- **Life-critical medications: YES.** Medical-safety consequences:
  - `MedicationRequest` carries extension `https://healmedaily.local/fhir/StructureDefinition/medicationrequest-life-critical` (valueBoolean), set by owner in med config UI — never inferred.
  - Dashboards: critical meds flagged per-med; missed-dose warnings prominent; critical gaps sort first.
  - Health Review: adherence gaps on critical meds listed first, factual tone, no dosing advice — display/organize only.
  - Changes to this behavior = ask the owner first (medical-safety rule §6).
- FHIR **R4**. Frontend: **fresh custom React app** (Foo Medical/hello-world as pattern references only).
- Units **kg**, clock **24h**. Health Review default window **90 days** (30/custom selectable).
- Docker via **Docker Desktop** (brew cask) unless owner prefers colima. Python **3.12** via brew.

## 9. Debugging

- Inspect/fix data in the Medplum App (:3000): resource browser, search, history, Subscriptions status, Bot logs (`AuditEvent`s). Don't build throwaway admin tooling.
- Server logs: `docker compose -f infra/docker-compose.yml logs -f medplum-server`.
- FHIR validation: `$validate` operation catches hallucinated fields/codes.
- Common gotchas: slow first boot; missing CSS imports; `VITE_` prefix; Mantine major mismatch; bots not enabled on project; bot subscription silently not retrying; `_total=none` default (no counts unless asked).
- ⚠️ **Transaction bundles are not all-or-nothing on validation errors** (observed on 5.1.26 with conditional creates): an invalid entry gets a per-entry 400 while valid entries commit — and intra-bundle references to the failed entry are left dangling. Always check every entry's `response.status` (seed.py dies on any non-200/201) and re-verify references after a partial failure.
- FHIR `time` values need seconds (`09:00:00`, never `09:00`) — e.g. `timing.repeat.timeOfDay`.
- **Attachment.url is rewritten on read**: Medplum returns presigned `/storage/{binaryId}/{versionId}?...` URLs whose signature binds to the public host — unusable inside the compose network. Server-side, extract the binary id and read via `GET fhir/R4/Binary/{id}` with `Accept: */*` (`medplum.read_attachment`). Browser-side `medplum.download(url)` is fine.
- **Requirements spec**: the owner's "Health Data Ingestion & Tracking Module" spec (v0.1, 2026-07-13) is the north star for capture/voice/cadence work — question bank (§12), dashboards catalog (§13), safety reqs (SR-*/VR-15..17), cadence codes (§11). Adopted so far: vitals capture+dashboard, correlations (SR-6 label), data-only clinician summary (FR-RPT-1/2), FHIR/CSV export (IR-1/IR-3/PR-4), rx-question capture (Q-MED-09), richer daily check-in. Deliberately deferred: vitals thresholds (SR-3 — set with clinician, never hardcode), voice AI (Phase 8), cadence engine + question bank at scale (Phase 6), body map, PHQ-9/GAD-7 screenings.
- Auth code exchange requires PKCE (`codeChallenge`/S256 at login, `code_verifier` at `oauth2/token`) — "Missing verification context" means you forgot it.
