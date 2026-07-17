# HealMeDaily — architecture diagrams

Drawn from the repository state (2026-07-16). Rendered natively by GitHub/Claude.
A styled version of this page is published as a private artifact; sources of truth:
[CLAUDE.md](../CLAUDE.md) · [FHIR-MAPPING.md](../FHIR-MAPPING.md) · [ONBOARDING.md](../ONBOARDING.md) · [DEPLOYMENT.md](../DEPLOYMENT.md)

Color language (same as the product): green = stays home · amber = leaves the device (named recipient + ledger) · indigo = AI-derived · red = medical-safety rule.

## 01 · Platforms & components — Everything, one trust boundary

Every platform talks to one FHIR CDR. The dashed box is the owner's hardware — the only thing that ever crosses it is an explicitly-routed AI call (amber) under the owner's own key.

```mermaid
flowchart LR
  subgraph HOME["🏠 Owner's machine / LAN — everything stays here"]
    direction LR
    subgraph CLIENTS["Clients"]
      WEB["Web app (React+Mantine)\ndesktop shell :5173/:8080"]
      MOB["Mobile PWA\nsame app, tab-bar shell\ninstallable iOS/Android"]
      ADMIN["Medplum admin app :3000\nresource browser, bot logs"]
    end
    subgraph MEDPLUM["Medplum (Docker) — the core backend"]
      SRV["medplum-server :8103\nFHIR R4 API · OAuth2/PKCE\nSubscriptions · $operations"]
      BOTS["Bots (vmcontext)\nqr→observations · symptom-follow-up\nreminders (cron 15m) · break-glass"]
      PG[("Postgres :5432\nthe entire CDR")]
      RD[("Redis :6379\ncache/queues")]
    end
    AI["ai-service (FastAPI :8000)\nOCR/vision · importers · Health Review\nAssistant · BYOK keystore + routing"]
    PI["pi-dispenser (Raspberry Pi)\nspindle/load-cell HAL\nsim-first, LAN only"]
    INBOX["data/inbox\nwatched folder"]
    SECRETS["data/secrets + macOS Keychain\nBYOK keys · AI routing (0600)"]
  end
  subgraph CLOUD["☁ Optional cloud — owner's own keys"]
    ANT["Anthropic"]
    OAI["OpenAI / custom endpoint"]
    GEM["Gemini"]
  end
  OLL["Ollama :11434\nlocal models"]

  WEB -- "FHIR REST (PKCE)" --> SRV
  MOB -- "FHIR REST (PKCE)" --> SRV
  ADMIN --> SRV
  WEB -- "HTTP" --> AI
  MOB -- "HTTP" --> AI
  AI -- "FHIR REST (client credentials,\nleast-privilege AccessPolicy)" --> SRV
  PI -- "FHIR REST (client credentials)" --> SRV
  SRV --- PG
  SRV --- RD
  SRV -- "Subscriptions / cron" --> BOTS
  BOTS -- "idempotent writes" --> SRV
  INBOX --> AI
  SECRETS --- AI
  AI -- "routed 'local'" --> OLL
  AI == "routed 'cloud' — AuditEvent\nwritten BEFORE the call" ==> ANT
  AI -.-> OAI
  AI -.-> GEM

  classDef green stroke:#0f8a63,stroke-width:2px
  classDef amber stroke:#c7811b,stroke-width:2px
  classDef store stroke:#86868b,stroke-width:1.5px
  class WEB,MOB,ADMIN,SRV,BOTS,AI,PI,OLL,INBOX,SECRETS green
  class ANT,OAI,GEM amber
  class PG,RD store
```

> no side database — if it's a health fact, it's a FHIR resource · admin is never rebuilt, the Medplum app is the admin

## 02 · Ingestion — Five ways in, one gate

AI-extracted content rides a review queue — nothing enters the record unapproved. Deterministic imports skip the queue by design but dedup on content-hash identifiers, so re-imports are no-ops. Every commit carries `Provenance`.

```mermaid
flowchart LR
  UP["PDF / photo upload"] --> OCR["extract: pypdf →\nTesseract OCR fallback\n→ AI proposal schema"]
  NL["Quick capture\n(plain words)"] --> NLP["AI structuring\n(routed provider)"]
  INB["data/inbox\nwatched folder (60s)"] -->|"pdf/png/jpg"| OCR
  INB -->|"json/csv/xml/cda/hl7"| IMP
  FHIRB["FHIR bundle .json"] --> IMP["deterministic importers\nsha256 content-hash identifier\n+ ifNoneExist dedup"]
  CSV["observations .csv"] --> IMP
  APPLE["Apple Health export.xml"] --> IMP
  CCDA["C-CDA .cda/.ccda\n(verified OIDs only)"] --> IMP
  HL7["HL7v2 ORU .hl7"] --> IMP

  OCR --> Q{{"REVIEW QUEUE\nTask intent=proposal\nnothing commits without you"}}
  NLP --> Q
  Q -->|"approve = $validate →\ntransaction: resource +\nProvenance + Task done"| CDR[("Medplum CDR")]
  Q -->|reject| X["Task rejected —\nno clinical resource\n(original kept)"]
  IMP -->|"direct commit\n'imported' tag + Provenance"| CDR

  classDef gate stroke:#5e5ce6,stroke-width:2.5px
  classDef safe stroke:#0f8a63,stroke-width:2px
  class Q gate
  class IMP,CDR safe
```

> originals immutable: DocumentReference + Binary (securityContext → Patient) · watcher archives to processed/ or failed/ — never double-ingests

## 03 · AI platform — BYOK, per-feature routing, loud boundaries

Four features route independently to local, cloud, or off. Keys live in the OS keychain (or an owner-only file) — never in FHIR, never in exports. Every cloud call writes a machine-coded `AuditEvent` (cloud-egress) before it fires; the History page is that ledger.

```mermaid
flowchart LR
  subgraph FEATURES["Per-feature routing (data/secrets/ai-settings.json)"]
    HR["health-review"]
    IE["ingest-extraction"]
    AS["assistant"]
    NI["nl-import"]
  end
  ROUTER{"route?"}
  HR & IE & AS & NI --> ROUTER
  ROUTER -->|local| OLLAMA["Ollama\nis_local=true · stays home"]
  ROUTER -->|off| OFF["503 — feature disabled\napp fully works without AI"]
  ROUTER ==>|"cloud — ledger first"| LEDGER["AuditEvent cloud-egress\nnames feature + provider"]
  LEDGER ==> PROV["Anthropic · OpenAI · Gemini\n(owner's key, from keystore)"]
  KEYS["Keystore\nmacOS Keychain → 0600 file\nmasked everywhere, never logged"] -.-> PROV

  subgraph ASSIST["Assistant contract"]
    A1["reads record → compact context\nwith citation tags [n]"]
    A2["answer must cite [n] → real resources\nnever diagnoses/doses"]
    A3["session = Communication\ndeletable, audit stub remains"]
    A1 --> A2 --> A3
  end
  AS -.-> ASSIST

  classDef amber stroke:#c7811b,stroke-width:2px
  classDef green stroke:#0f8a63,stroke-width:2px
  classDef ai stroke:#5e5ce6,stroke-width:2px
  class PROV,LEDGER amber
  class OLLAMA,KEYS,OFF green
  class ASSIST,A1,A2,A3 ai
```

> read-only by construction: the assistant's only write is its own Communication log · NL capture proposes via the review queue, never commits

## 04 · Dose events — One logical dose, three writers, zero divergence

The app, the dispenser and the reminders bot all derive the identical slot identity `{request-slug}-{date}T{HH:MM}` — a dispenser pickup updates the same `MedicationAdministration` a tap would. No log means no resource; "missed" is never persisted from elapsed time alone.

```mermaid
sequenceDiagram
    participant MR as MedicationRequest<br/>(schedule, timeOfDay)
    participant APP as Web/Mobile app
    participant PI as Pi dispenser
    participant BOT as reminders-runner<br/>(cron 15m, owner TZ)
    participant CDR as Medplum CDR

    Note over MR: slot identity = {slug}-{date}T{HH:MM} — shared by all three
    MR->>APP: due/overdue derived live (90min grace, display-only)
    MR->>PI: today's slots → tray schedule
    PI->>CDR: MedicationDispense (wedge drop, T0)
    PI->>CDR: MedicationAdministration<br/>verification: weight > camera > self
    APP->>CDR: same identifier — taken/skip/missed tap<br/>(skipped→taken updates, never duplicates)
    BOT->>CDR: overdue + unlogged + no reminder yet?<br/>CommunicationRequest only (never dose status)
    PI->>PI: escalation ladder (owner-configured)<br/>T0 chime → T15 push → T45 ask-why → T2h close
    PI-->>CDR: 'missed' written ONLY if owner's config says so
```

> life-critical flag: owner-set extension, never inferred · critical gaps sort first everywhere · inventory never gates whether a med may be taken

## 05 · Automation — Bots: event-driven + cron, idempotent by law

Bot subscriptions never retry, so every bot writes through stable identifiers with conditional creates — a missed run is always recoverable, a replay is always a no-op.

```mermaid
flowchart LR
  QR["QuestionnaireResponse\ncreate OR update"] -->|Subscription| B1["qr→observations\nupserts by {responseId}-{linkId}\namendments propagate"]
  SYM["Observation code=symptom\ncreate"] -->|Subscription| B2["symptom-follow-up\nnext-day Task (display-only)"]
  CRON1["cron */15"] --> B3["reminders-runner\nowner-TZ slots → CommunicationRequest\nidempotent: reminder/{request}/{occurrence}"]
  CRON2["cron */15"] --> B4["break-glass sweep\nrestores expired 24h grants\n(unstamped = expired, fail-safe)"]
  ACT["Parameters / Communication\n(emergency activation)"] --> B4
  B1 & B2 & B3 & B4 --> CDR[("CDR — audit trigger on-output\nno success-spam AuditEvents")]

  classDef bot stroke:#0f8a63,stroke-width:2px
  class B1,B2,B3,B4 bot
```

> deploy: make bots — reconciles drifted Subscriptions in place, grants break-glass its admin membership, sets cron + audit triggers

## 06 · Care circle — Sharing has exactly one mechanism

Every member is a `ProjectMembership` bound to a scoped read-only `AccessPolicy` pinned to the patient. The caretaker's app is the same app — the server simply returns less. Break-glass audits before it grants.

```mermaid
flowchart LR
  OWNER["Owner\n(project admin)"] -->|"Access Control page\nlive scope toggles"| POL["AccessPolicy\ncare-circle/caretaker/{email}\nreadonly · %patient-pinned"]
  CLI["scripts/care_circle.py\nadd-caretaker · add-clinician-share\nset-scopes · revoke · expire-shares"] --> POL
  POL --- M1["ProjectMembership\ncaretaker (RelatedPerson)"]
  POL2["care-circle/clinician-share/{email}\n+ expiry marker (Basic)"] --- M2["ProjectMembership\nclinician (Practitioner)"]
  M1 --> APP2["Same app, scoped view\nlocked areas = server denial,\nnever a client-side filter"]
  M2 --> APP2

  subgraph BG["Break-glass (emergency)"]
    direction LR
    E1["AuditEvent FIRST\n(permanent)"] --> E2["swap to emergency policy\n12 clinical read-only types\nnever secrets/bots/policies"] --> E3["owner notified\n(Communication)"] --> E4["24h expiry stamped\ncron sweep self-restores"]
  end
  M1 -.-> BG

  classDef red stroke:#d64545,stroke-width:2px
  classDef green stroke:#0f8a63,stroke-width:2px
  class BG,E1,E2,E3,E4 red
  class POL,POL2,CLI,APP2 green
```

> "who looked, lately" = AuditEvent search by member agent · every read is on the record

## 07 · Deployment topologies — Same stack, three postures

Recommended: Tailscale — access from anywhere while the record stays home. The cloud stack exists (`infra/docker-compose.cloud.yml`) but moves custody to rented hardware; only Caddy is exposed there, everything else internal-only.

```mermaid
flowchart LR
  subgraph DEV["Dev (make up + make dev)"]
    D1["Vite :5173 · uvicorn :8000\nMedplum :8103/:3000\nall localhost"]
  end
  subgraph TS["Tailscale — recommended"]
    T1["make prod-up at home\ntailscale serve → ts.net HTTPS\nWireGuard end-to-end"]
    T2["Phone PWA anywhere\nrecord never leaves home"]
    T1 --- T2
  end
  subgraph VM["Cloud VM (option B)"]
    C0["Caddy :80/:443\nLet's Encrypt · ONLY exposed service"]
    C1["app.{d} → web\nfhir.{d} → medplum-server\nmedplum.{d} → admin\nai.{d} → ai-service"]
    C2["postgres/redis internal-only\nencrypted volume · ufw · fail2ban\nencrypted off-VM backups"]
    C0 --- C1 --- C2
  end
  DEV -->|"same images,\nsame make targets"| TS
  TS -->|"only if home\ncan't stay on"| VM

  classDef green stroke:#0f8a63,stroke-width:2px
  classDef amber stroke:#c7811b,stroke-width:2px
  class DEV,TS,D1,T1,T2 green
  class VM,C0,C1,C2 amber
```

> full walkthroughs in DEPLOYMENT.md · fresh-install bootstrap needs registration enabled exactly once

## 08 · Data model — FHIR resource map (orientation)

The canonical mapping lives in `FHIR-MAPPING.md` — this is the shape of it. Verified codes only (LOINC/SNOMED/RxNorm); everything else uses project-local systems under `healmedaily.local`.

```mermaid
flowchart TB
  P["Patient (one)"]
  P --- MEDS["Medication + MedicationRequest\nSIG text · life-critical extension"]
  MEDS --- MA["MedicationAdministration\none logical dose event\ncompleted | not-done + reason"]
  MEDS --- MD["MedicationDispense\n(dispenser wedge drop)"]
  P --- Q["Questionnaire (D/W/M cadence)\n→ QuestionnaireResponse\n→ Bot → Observations (derivedFrom)"]
  P --- OBS["Observation\nvitals · trackers · symptoms · labs"]
  OBS --- DR["DiagnosticReport\n(lab panels, HL7v2 OBR)"]
  P --- DOC["DocumentReference + Binary\noriginals, immutable,\nsecurityContext → Patient"]
  DOC --- TASK["Task intent=proposal\nreview queue"] --- PROV["Provenance\non every commit"]
  P --- DEV2["Device: pill-dispenser (parent)\n← cartridges (Device.parent)\ncapacity/remaining/threshold"]
  DEV2 --- SD["SupplyDelivery (refill,\ntransaction + ifMatch)"]
  P --- COMM["Communication\nassistant sessions (deletable)\n+ CommunicationRequest (reminders)"]
  P --- AUD["AuditEvent\nboundary ledger (cloud-egress)\nbreak-glass · who-looked"]
  ACCESS["AccessPolicy + ProjectMembership\ncare circle — the only sharing"] --- P

  classDef core stroke:#0f8a63,stroke-width:2px
  classDef gate stroke:#5e5ce6,stroke-width:2px
  classDef audit stroke:#c7811b,stroke-width:2px
  class P,MEDS,MA,MD,Q,OBS,DR,DEV2,SD,COMM core
  class TASK,PROV gate
  class AUD,ACCESS audit
```

> idempotency: stable business identifiers + ifNoneExist everywhere a retry can happen · transactions checked per-entry (Medplum partial-commit quirk)
