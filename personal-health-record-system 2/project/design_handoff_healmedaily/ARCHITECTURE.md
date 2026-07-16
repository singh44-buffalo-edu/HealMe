# HealMeDaily — Medplum Architecture

How the designed platform maps onto Medplum as the backend. Read alongside README.md. Deployment model: **self-hosted Medplum server on the user's own machine** (arun-mini.local), one Project, one Patient, no tenants.

## Topology

```
┌─ user's LAN ────────────────────────────────────────────────┐
│                                                              │
│  Libre 3 CGM ──BLE──┐                                        │
│  Pi dispenser ──────┤                                        │
│  Withings/BP ──LAN──┼──► Medplum Agent ──► Medplum Server    │
│                     │        (device       (FHIR R4 + Bots   │
│  Phone (HealthKit)──┘         gateway)      + Subscriptions) │
│                                              │               │
│  Ollama + Tesseract (local AI/OCR) ◄─────────┤               │
│  Web app / Mobile app ◄── Subscriptions ─────┘               │
└──────────────────────────────────────────────────────────────┘
   Cloud (optional, BYO key): Anthropic/OpenAI — de-identified
   digests only, every call logged to the boundary ledger.
```

- **Medplum Agent** is the on-prem gateway for all device traffic (dispenser events, BLE bridges). Nothing device-related traverses the internet — this implements the "never leaves the LAN" promise.
- **OAuth services** (Withings, Oura) sync via Bots on the server.

## Resource mapping — by screen

- **Dashboard** — Observation (metrics), MedicationRequest + next-dose logic, DetectedIssue (insights), Appointment (upcoming), AuditEvent feed. Live tiles: `useSubscription` on Observation criteria.
- **Ingestion / Review queue** — every pending item is a **Task** (`status: requested → completed/rejected`, `focus:` the staged Bundle). Approve = complete Task + commit staged resources + **Provenance** per Observation (source device/Bot/document, who approved). Conflicts: Task with two candidate Observations; resolution writes preferred-source flag.
- **Scan & confirm** — DocumentReference + Binary (original kept forever); extracted values staged as Observations (LOINC-coded) linked via Provenance `entity`.
- **Devices** — Device + DeviceMetric (calibration state); ingest pipeline = Agent → Bot (`cgm-ingest`, `med-events`) → Observation.
- **Dispenser** — MedicationRequest (schedule) → **MedicationDispense** (wedge drop, T0) → **MedicationAdministration** (pickup, verified by load cell; `method` extension: weight/camera/self). Timeliness = Administration.effectiveDateTime − Dispense.whenHandedOver. Refill = SupplyDelivery per tray with lot/expiry. Skip reasons = **QuestionnaireResponse**.
- **Medications** — MedicationRequest, adherence strips computed from Dispense/Administration pairs.
- **Vitals / Labs** — Observation; targets are **Goal** resources (e.g. BP <120/80 agreed with Dr. Rao) — chart bands and assistant citations reference the Goal, not hardcoded copy. Panels: DiagnosticReport grouping Observations.
- **AI Insights** — DetectedIssue (flags) + RiskAssessment (forecasts, `probability`/confidence); evidence links = `evidence.detail` references. Dismiss/track feedback stored as Task or extension feeding the local model.
- **Explorer** — GraphQL queries for multi-signal overlays; saved views = user preference resources (Basic).
- **Assistant** — read-only client; every citation is a resource reference. Q&A sessions = Communication resources (deletable; deletion leaves AuditEvent stub).
- **Timeline / History** — FHIR history API (`_history`) + **AuditEvent** for every read/write/AI call/deletion. Edits are new resource versions — v1 is never destroyed (native Medplum versioning).
- **Privacy Vault** — boundary ledger = AuditEvent filtered to network egress; "Export everything" = bulk **$export**; backups external.
- **AI Settings** — BYO keys live in the OS keychain, never as FHIR resources; per-feature routing config = Project secrets/settings. Cloud calls always via a Bot that de-identifies first and writes an AuditEvent.
- **Care circle (Caretaker View / Access Control)** — each member = **ProjectMembership** with a scoped **AccessPolicy** (resource-type + criteria based; Arun: meds/vitals/alerts; Priya: alerts only). Owner's scope toggles edit the AccessPolicy live. Time-boxed clinician share = AccessPolicy with expiry + share link. **Break-glass** = Bot that swaps the caretaker's AccessPolicy to full for 24h, notifies the owner (Communication), and writes a permanent AuditEvent.
- **Alerts & escalation** — rules = PlanDefinition (or Bot cron); each rung fires a **CommunicationRequest** → Communication (dispenser chime, push, caretaker nudge).
- **Manual entry / journal / check-ins** — **Questionnaire** + QuestionnaireResponse rendered with Medplum's QuestionnaireForm; extracted Observations via Bot.
- **Clinician Share** — server-rendered read-only view under the share AccessPolicy; PDF + FHIR bundle downloads scoped to the same policy.

## Bots (server-side, all local)

`cgm-ingest` (validate/dedup/Observation), `med-events` (Dispense/Administration from Agent), `oauth-sync-withings`, `oauth-sync-oura`, `ocr-extract` (Tesseract → staged Task), `pill-vision` (on-Pi, tray verification), `anomaly-detect` (cron → DetectedIssue), `correlate-forecast` (Ollama → RiskAssessment), `deidentify-cloud` (BYOK calls + ledger), `break-glass`, `escalation-runner`, `backup-verify`.

## Invariants to enforce in code
1. Nothing enters the record without a completed review Task (except device streams the user has pre-approved per-source).
2. Every Observation carries Provenance; every network egress writes an AuditEvent before the call.
3. Edits create versions; only Communications/journal support true delete (with AuditEvent stub + backup purge job).
4. AccessPolicies are the only sharing mechanism — no ad-hoc queries across members.
