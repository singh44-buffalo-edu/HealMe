# HealMeDaily — living project guide

Last reviewed: 2026-07-13  
Current phase: Phase 1 design proposal — awaiting owner sign-off  
FHIR version: R4 (4.0.1)  
Repository root: `/Users/abhigyan/Documents/HealMeDaily/Claude Code`

## 1. Product and non-negotiables

HealMeDaily is a private, laptop-first electronic health record for one person. It records medication intake and adherence, daily check-ins, quick health observations, cartridge configuration, imported medical documents, and clinician-facing health reviews. It runs against self-hosted Medplum; the Medplum Clinical Data Repository (CDR) is the only clinical system of record.

The primary engineering rule is: **keep a runnable end-to-end system**. After the design gate, every phase must end with a buildable, bootable stack and a passing smoke test. If a feature threatens the running path, reduce the feature before complicating the platform.

Other non-negotiables:

- Clinical data lives in Medplum FHIR R4, not a side database.
- Frontend and Bots use `MedplumClient` and types from `@medplum/fhirtypes`.
- The Python service uses OAuth2 client credentials and FHIR REST.
- Secrets stay in the root `.env`; `.env.example` contains names and safe defaults only.
- The app starts without an AI key. AI screens show a provider-configuration state.
- AI/OCR extraction is proposal-only until the user explicitly confirms it.
- AI summarizes and organizes data; it does not diagnose, prescribe, recommend treatment, or silently alter the record.
- Standard terminology is used only after verification. Raw source text/value is retained.
- Multi-resource writes that must remain consistent use FHIR transaction Bundles.
- Retries are idempotent through stable identifiers and conditional create/update.
- No third-party analytics.

Phase 1 is the pre-code design gate requested by the owner, so there is no runtime to start yet. Phase 2 is not complete until all three tiers are running and `make smoke` passes.

## 2. Architecture

```text
Custom React frontend (Vite, React, @medplum/react, Mantine) :5173
        |  browser auth + FHIR REST/GraphQL through MedplumClient
        v
+---------------- self-hosted Medplum ----------------+
| App/admin :3000 | FHIR/OAuth server :8103            |
| Auth | CDR | Bots | Subscriptions | Postgres | Redis |
+------------------------^------------------------------+
                         | OAuth2 client credentials + FHIR REST
Python FastAPI service :8000
  AI provider adapters | health review | OCR/PDF | ingestion proposals
```

### Responsibilities

| Surface | Owns | Does not own |
| --- | --- | --- |
| React frontend | Login, one-tap logging, check-ins, dashboards, cartridge UI, document upload/review, health-review UI | Clinical persistence outside FHIR; heavy OCR/AI |
| Medplum server | OAuth, FHIR R4 CDR, search, history, access control, transactions, file storage | Custom dashboard UX; long-running document processing |
| Medplum Bots | Small deterministic FHIR transforms triggered by Subscriptions | OCR, LLM calls, PDF parsing, large imports |
| Python FastAPI service | Client-credential auth, OCR/PDF processing, AI adapters, health-review context building, ingestion proposals/finalization | A second clinical database; browser user authentication |
| Medplum App | Project/admin setup, data inspection, history, troubleshooting | Custom patient product UI |

### Bot/service boundary

- MVP Bot: `QuestionnaireResponse` to idempotent `Observation` resources. This form uses the Bot strategy only; do not also configure SDC template extraction.
- Later small Bots: event-triggered question scheduling or small FHIR-only transforms.
- Python service: any task involving files, OCR, LLMs, provider APIs, large import parsing, aggregation, or PDF generation.

## 3. Repository layout

```text
backend-bots/       TypeScript Bots, tests, Medplum Bot config
frontend/           Vite React application
ai-service/         FastAPI service and Python tests
scripts/            seed, smoke, and maintenance scripts
infra/              pinned local Medplum Compose configuration
data/               ignored local inbox and generated working data
codex.md             this living source of truth
FHIR-MAPPING.md      canonical domain-to-FHIR mapping
TODO.md              phase tracker
.env.example         safe configuration contract
Makefile             one-command operating habits (created in Phase 2)
```

## 4. Current design decisions

### Accepted defaults, pending sign-off

- Frontend: a fresh custom Vite React TypeScript app, not a Foo Medical or Medplum App fork. Foo Medical is broader than this single-user product; we will reuse focused Medplum components and patterns instead.
- FHIR: R4 only.
- Local Medplum: start from the official full-stack Compose file, then pin both Medplum images to `5.1.24`. Postgres stays on 16 and Redis on 7 as in the official file.
- UI defaults: pounds, 12-hour clock, and America/Los_Angeles time zone.
- Health Review default: 90 days, with 30-day and custom options.
- MVP data ingestion: PDFs/images first. Other formats stay in later ingestion phases unless the owner identifies a format that must move earlier.
- MVP AI provider: Anthropic adapter first, selected only when configured. No key means disabled UI, not a failed app.
- Local document text extraction: Tesseract and Poppler. No document is sent to a cloud model without an explicit privacy disclosure and confirmation.
- Health Review is generated on demand and is not stored by default. A downloaded PDF contains its time window, generated timestamp, source-data cutoff, and medical-advice disclaimer.

### Decisions requiring owner confirmation before Phase 2 or the affected MVP work

1. Which AI provider keys are available, and whether the privacy stance is cloud, local-first, or per run.
2. Whether pounds/12-hour time are correct.
3. Whether the 90-day Health Review default is correct.
4. Which existing source formats are actually available.
5. Whether any tracked medication is life-critical.
6. Adherence semantics: the MVP will never infer and persist a “missed” dose merely from absence. It may display “overdue/unlogged”; only an explicit user action creates a `not-done` administration marked missed.
7. Cartridge model: `Device` plus the project extensions/properties defined in `FHIR-MAPPING.md`.
8. Existing repository location: continue in the already initialized `Claude Code` subdirectory shown above.

Changes to the FHIR model after MVP, new heavy dependencies, auto-commit extraction, or medication/adherence safety behavior require fresh owner approval.

## 5. Walking skeleton design (Phase 2)

### Prerequisites

Current Medplum CLI documentation requires Node.js 22+, which supersedes the original Node 20+ note.

Required:

- Docker and Docker Compose
- Node.js 22+ and npm
- Python 3.11+
- Git
- Tesseract and Poppler before ingestion work

Detected on 2026-07-13:

| Tool | Detected | State |
| --- | --- | --- |
| Docker / Compose | not installed | blocker for Phase 2 |
| Node | 26.0.0 | acceptable for initial work; use Node 22 LTS if compatibility issues appear |
| npm | 11.15.0 | available |
| Python | 3.9.6 only | install Python 3.11+ |
| Git | 2.50.1 | available |
| Tesseract | not installed | required before ingestion slice |
| Poppler | not installed | required before ingestion slice |
| Homebrew | 6.0.9 | available for local installation |

Proposed macOS prerequisite installation (run only after sign-off):

```bash
brew install --cask docker
brew install python@3.11 tesseract poppler
```

Docker Desktop must be opened once after installation so its engine is running.

### Medplum bring-up

Phase 2 will copy the current official file into `infra/docker-compose.yml`, pin `medplum-server` and `medplum-app` to `5.1.24`, and replace permissive `*` CORS with:

```text
http://localhost:3000,http://localhost:5173
```

The browser origin calling Medplum is `:5173`; server-to-server calls from Python do not use CORS. FastAPI separately permits `http://localhost:5173`.

One-time Medplum project setup:

1. Run `make up` and wait for `http://localhost:8103/healthcheck`.
2. Open `http://localhost:3000` and register the first user/project.
3. Enable project features `bots` and `transaction-bundles`. Transaction Bundles silently degrade to batch behavior when the feature is disabled, so the smoke test must verify atomic transaction support before relying on it.
4. Create or identify the single Patient.
5. Create a `ClientApplication` for the Python service, attach its least-privilege `AccessPolicy`, and put its ID/secret in the root `.env`.
6. Set `MEDPLUM_PATIENT_ID` in `.env`, or let the idempotent seed script conditionally create the configured patient identifier.

### Frontend skeleton

- Fresh Vite React TypeScript application on `:5173`.
- `MedplumClient({ baseUrl: VITE_MEDPLUM_BASE_URL })` inside `MedplumProvider`.
- `MantineProvider`, `@mantine/core/styles.css`, and `@medplum/react/styles.css` imported as required by current docs.
- `SignInForm` followed by a signed-in page that reads and displays the configured single Patient.
- The frontend connects directly to Medplum; it calls FastAPI only for AI/ingestion operations.

### Python skeleton

- FastAPI on `:8000` with `GET /health` returning 200 without credentials or AI keys.
- A Medplum token client posts client credentials to `/oauth2/token`, caches the token until shortly before expiry, and retries once after refreshing on 401.
- A connectivity check reads only the configured Patient.
- Provider registry starts even with no provider configured.

### Seed and smoke behavior

`scripts/seed.py` posts idempotent transaction Bundles with stable identifiers. It creates/ensures:

- the configured Patient;
- daily-check-in Questionnaire;
- sample Medication and MedicationRequest resources;
- sample cartridge Devices;
- sample Observation and MedicationAdministration resources.

`scripts/smoke_test.py` checks, in order:

1. Medplum `/healthcheck` is 200.
2. FastAPI `/health` is 200.
3. Client-credential token acquisition succeeds.
4. The configured Patient can be read.
5. A uniquely identified test Observation can be conditionally created and read back.
6. The transaction feature behaves atomically.
7. The frontend root responds successfully.

The smoke script exits non-zero on any failure and cleans up only resources identified as smoke data when safe to do so.

## 6. Exact operating commands (target contract for Phase 2)

These commands are the required public interface of the repository. They are documented now and implemented/tested in Phase 2.

```bash
cp .env.example .env
make setup
make up
make seed
make dev
```

`make dev` stays in the foreground and runs both frontend and FastAPI. In another terminal:

```bash
make smoke
```

Normal later use:

```bash
make up
make dev
```

Validation before a phase commit:

```bash
make test
make build
make smoke
```

Shutdown:

```bash
make down
```

Planned Make targets:

| Target | Contract |
| --- | --- |
| `setup` | Install frontend/Bot packages; create Python 3.11 virtualenv; install pinned Python requirements |
| `up` | Start pinned Medplum Compose stack and wait for health |
| `down` | Stop the stack without deleting volumes |
| `dev` | Run frontend and FastAPI together; forward signals cleanly |
| `seed` | Idempotently ensure configured sample data |
| `smoke` | Execute the end-to-end checks above |
| `test` | Run frontend/Bot unit tests and Python pytest suite |
| `build` | Type-check/build frontend and Bots; compile Python modules |
| `logs` | Show Medplum service logs for troubleshooting |

Destructive volume deletion is intentionally not a standard Make target.

## 7. FHIR conventions

The canonical domain map is [FHIR-MAPPING.md](./FHIR-MAPPING.md). These rules apply everywhere:

- Annotate TypeScript FHIR objects with `@medplum/fhirtypes` types.
- Validate important generated examples with Medplum `$validate` once the local server is running.
- Never invent a FHIR field, search parameter, LOINC, SNOMED, ICD, or RxNorm code.
- Keep the raw source text/value alongside verified coding.
- Use stable absolute identifier-system and canonical URLs under `https://healmedaily.local/fhir/`.
- Use `urn:uuid:` `fullUrl` references inside transactions when new entries reference one another.
- Keep conditional transactions at eight entries or fewer; current Medplum applies this limit when a transaction contains conditional operations.
- Use server search with `_count`, `_sort`, date bounds, and includes where applicable. Paginate; do not load the CDR and filter it in browser code.
- Use optimistic version checks (`ifMatch`) for stock changes and other concurrent updates.
- Uploaded content is a Medplum `Binary` referenced by `DocumentReference`; do not embed large base64 data in `Attachment.data`.
- Give each Binary an appropriate `securityContext`.
- Every finalized extraction gets `Provenance` pointing to both the resulting resource and its source `DocumentReference`.

## 8. Authentication, authorization, privacy, and safety

### Authentication

- Browser: Medplum browser authentication through `MedplumClient` and the custom React portal.
- Python: OAuth2 client credentials. The secret never enters frontend code or `VITE_*` variables.
- Future hardware: its own ClientApplication credential and AccessPolicy; never reuse the Python credential.

### Python AccessPolicy direction

The MVP service policy grants:

- read/search on the one Patient and the clinical resources needed for Health Review;
- read/create on Binary and DocumentReference for source uploads;
- read/create/update on ingestion Tasks;
- create on Provenance and confirmed target resource types;
- no delete;
- no broad `*` rule.

The concrete policy must be reviewed against the current Medplum access-policy docs and manually inspected before use with real PHI. Binary access is controlled through `Binary.securityContext` rather than search criteria.

### AI safety

- Every generated summary and PDF states: “Not medical advice — a discussion aid; review with a qualified clinician.”
- Provider configuration and privacy disclosure appear before the first cloud transmission.
- No provider configured means no transmission and no application failure.
- Prompts require grounded summaries, explicit uncertainty, source-data cutoff, and data-gap reporting.
- The service does not create diagnoses, orders, regimen changes, or adherence events from AI output.
- Mental-health summaries remain supportive and neutral; sustained serious distress may surface professional/crisis resources without asserting a diagnosis.
- Weight is presented neutrally. No default goal weight, calorie logic, or diet target.

### Medication safety boundary

- A missing log is not automatically a missed dose.
- Dashboard schedule states are computed display states, not treatment advice.
- Cartridge counts are inventory estimates and never authorize, block, or recommend a dose.
- Stock decrement and administration creation must be one transaction when both occur.
- Any change to these semantics requires owner approval.

## 9. Testing strategy

- Frontend: unit tests for FHIR builders, schedule display calculations, and error/empty states; component tests for the MVP flows.
- Bots: unit tests with `@medplum/mock` `MockClient`; duplicate delivery and update replay tests are mandatory.
- Python: pytest for token caching, provider-disabled state, FHIR context aggregation, OCR proposal generation, confirmation gate, and redaction-safe errors.
- FHIR: typed resources plus local server `$validate` for representative resources.
- End to end: `make smoke` after every phase and focused browser verification of the core user flow when UI exists.

No phase advances while build, tests, startup, or smoke are red.

## 10. Phase plan and definition of done

### Phase 1 — design proposal (current)

- Read current Medplum documentation and examples.
- Establish this guide, canonical FHIR mapping, environment contract, and todo.
- Record decisions and prerequisites.
- Stop for owner sign-off.

Phase 1 has no application runtime by explicit design-gate request. Its completion test is document review plus clean version-control state.

### Phase 2 — walking skeleton

- Install/verify prerequisites.
- Bring up pinned Medplum, frontend, and FastAPI.
- Configure auth, CORS, project features, Patient, and service ClientApplication.
- Implement idempotent seed and end-to-end smoke test.
- Prove login and all three tiers.

### Phase 3 — MVP

- Intake/adherence logging, daily check-in, quick Observations.
- Cartridge configuration and refill/decrement transactions.
- Medication Adherence and Health Overview dashboards.
- QuestionnaireResponse extraction Bot.
- Provider interface, one configured AI adapter, Health Review, and PDF.
- PDF/image upload, OCR/extraction proposals, Task review, confirmation, finalization, Provenance.

### Phase 4 — ingestion depth

- OCR robustness and scanned-photo handling.
- FHIR Bundle, C-CDA, HL7 v2, CSV, Apple Health, and Health Connect importers as actual source availability requires.
- Deduplication/reconciliation, watched folder, scheduled imports, scalable review queue.

### Phase 5 — more dashboards

- Sleep/weight/mood trends, symptoms versus medication changes, labs, correlations, response explorer.

### Phase 6 — question engine

- Configurable Questionnaire bank, cadences, event triggers, Subscriptions/Bots, related dashboards.

### Phase 7 — AI depth

- Remaining provider adapters, local Ollama path, ask-your-data, confirmation-first natural-language logging, PDF polish.

### Phase 8 — hardware

- Dispenser Device, per-device credential, voice check-ins, confirmation-first dispensing, and unchanged cartridge API.

### Phase 9 — hardening

- Final least-privilege policies, encryption/backups, reminders, deployment containers, audit review, recovery test, and UI polish.

Every implementation phase is done only when:

1. Code builds.
2. Unit/integration tests pass.
3. The full stack starts from documented commands.
4. `make smoke` passes.
5. The core phase flow is exercised.
6. Documentation and `.env.example` match reality.
7. No secrets or real patient data are staged.
8. The phase is committed with a focused commit.
9. The owner receives exact run/test commands and the next sign-off gate.

## 11. Documentation baseline

Authoritative sources reviewed on 2026-07-13:

- [Building on Medplum with AI Coding Assistants](https://www.medplum.com/docs/building-with-ai-coding-assistants)
- [FHIR Basics](https://www.medplum.com/docs/fhir-basics)
- [Full stack in Docker](https://www.medplum.com/docs/self-hosting/running-full-medplum-stack-in-docker)
- [Server configuration](https://www.medplum.com/docs/self-hosting/server-config), [CORS](https://www.medplum.com/docs/self-hosting/setting-up-cors), [super admin](https://www.medplum.com/docs/self-hosting/super-admin-guide), and [upgrades](https://www.medplum.com/docs/self-hosting/upgrading-server)
- [Authentication](https://www.medplum.com/docs/auth), [client credentials](https://www.medplum.com/docs/auth/client-credentials), and [AccessPolicy](https://www.medplum.com/docs/access/access-policies)
- [FHIR datastore](https://www.medplum.com/docs/fhir-datastore), [transactions](https://www.medplum.com/docs/fhir-datastore/fhir-batch-requests), [Binary data](https://www.medplum.com/docs/fhir-datastore/binary-data), [search](https://www.medplum.com/docs/search), and [GraphQL](https://www.medplum.com/docs/graphql)
- [TypeScript SDK](https://www.medplum.com/docs/sdk/core) and [React components](https://www.medplum.com/docs/react)
- [Bots](https://www.medplum.com/docs/bots), [Subscriptions](https://www.medplum.com/docs/subscriptions), and [CLI](https://www.medplum.com/docs/cli)
- [Questionnaires](https://www.medplum.com/docs/questionnaires), [medications](https://www.medplum.com/docs/medications), [intake](https://www.medplum.com/docs/intake), [AI](https://www.medplum.com/docs/ai), and [C-CDA](https://www.medplum.com/docs/integration/c-cda)
- [Hello World](https://www.medplum.com/docs/tutorials/medplum-hello-world), [Patient Intake Demo](https://github.com/medplum/medplum-patient-intake-demo), [Foo Medical](https://github.com/medplum/foomedical), and [main Medplum repository](https://github.com/medplum/medplum)
- HL7 FHIR R4 pages for Device, MedicationAdministration, SupplyDelivery, Task, and Provenance.

Re-read the relevant current page before implementing each area. When docs and this file disagree, current Medplum docs and FHIR R4 win; update this file in the same change.

