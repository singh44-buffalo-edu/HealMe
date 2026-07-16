# Handoff: HealMeDaily — Personal Health Record System

## Overview
HealMeDaily is a **self-hosted, single-patient EHR** built on Medplum (FHIR R4). It captures health data from every source a person has — wearables (Apple Watch, Oura), CGM (Libre 3), smart devices (Withings scale/BP cuff), a Raspberry Pi pill dispenser, provider portals (SMART-on-FHIR), scanned paper documents, CSVs, and manual entry — and layers opt-in AI (local Ollama by default, cloud with the user's own API key) for anomaly detection, correlations, forecasts, and a record-grounded assistant.

The product's central promise, carried in the UI itself: **everything stays on the user's device.** Nothing enters the record unapproved; nothing leaves the device silently.

## About the Design Files
The `.dc.html` files in this bundle are **design references created in HTML** — high-fidelity prototypes showing intended look and behavior, **not production code**. Your task is to **recreate these designs in the target codebase's environment**. The intended stack is **React + Mantine + @medplum/react** (Medplum's component library inherits theming via MantineProvider), but adapt to whatever the codebase uses. If no codebase exists yet, React + Mantine + Medplum is the recommended starting point.

Each `.dc.html` file contains an HTML template (inside `<x-dc>`) with all styling inline, plus a small logic class (in a `<script data-dc-script>` tag) holding the sample data arrays and interaction state. Read both: the template gives exact styling; the logic class gives content structure (useful as TypeScript interface starting points).

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii, shadows, and copy are final. Recreate pixel-perfectly using the codebase's component library, mapped through the design tokens below.

## Design System Summary
Full reference: `HealMeDaily Design System v2.dc.html`.

Aesthetic: Apple restraint + Dyson engineered precision. Near-white surfaces, borderless cards on soft shadows, one health-green brand color, color lives in data (lines/dots/rings) never in chrome.

### Three data classes — must stay unmistakable everywhere
- **Measured** — ink (#1D1D1F), plain.
- **Live device** — health green (#0F8A63) with a 1.6–2s opacity pulse on the status dot.
- **AI-derived** — indigo (#5E5CE6), always labeled with a `✦ AI` pill and a confidence value. Never render AI output without the label.

### Privacy boundary language
- Green dot + "stays home" = local processing.
- Amber (#C7811B) dot + "leaves device" = cloud; always names the recipient.
- Every screen carries the **VaultChip**: pill, `#F4F4F2` bg, green dot, mono 10.5px "On this device".

## Design Tokens

### Colors — light (default)
| Token | Hex | Use |
|---|---|---|
| canvas | #EFEFED | page background |
| card | #FFFFFF | card surfaces |
| ink | #1D1D1F | primary text, measured data |
| secondary | #6E6E73 | body/secondary text |
| tertiary | #86868B | metadata, mono labels |
| quaternary | #AEAEB2 | faint metadata |
| health green | #0F8A63 | brand, primary buttons, live |
| green hover | #0A6B4C | link hover |
| in-range | #1E9E6A | good status dots/text |
| watch | #C7811B | warning status, cloud boundary |
| out-of-range | #D64545 | bad status, destructive |
| AI indigo | #5E5CE6 | AI class (deep var #4B49C8) |
| AI bg | #EFEFFC | AI pill background |
| band | #F4F4F2 | reference bands, input bg |
| chip | #F0F0EE | segmented controls, hairlines |
| hairline | #E8E8E5 / #F4F4F2 | borders, row dividers |

### Colors — dark (true black) and live-glucose deep theme
canvas #161617 · card #1F1F21 · ink #F5F5F4 · secondary #98989D · green #30C98A · indigo #8B89F2 · band #2A2A2C. Live glucose tiles use deep-green theme: bg #062E22 (dark: #0B2A20), text #F2FBF7, accent #4FD6A6, muted #8FC9B4 / #5E9781.

### Metric accents (data viz only — lines, dots, rings)
heart #FF375F · glucose #0F8A63 · sleep #00B7C3 · activity #FF9500 · blood pressure #0A84FF (dia lighter #7CBBFF) · weight/body #BF5AF2 · respiratory #64D2FF · labs #E8B10E

### Typography
- **UI**: system stack `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif`
- **Numbers/units/timestamps/codes only**: `IBM Plex Mono` (Google Fonts, 400/500)
- Scale: display 38/42·600·−2.8% | h1 26/32·600·−2% | h2 17/24·600·−1.5% | body 14.5/23·400 | label 12/16·500 | metric-lg 30 mono 500 | metric-sm 15 mono 500 | micro 10.5 mono caps, letter-spacing .12em
- Negative letter-spacing (−.01 to −.028em) on all headings/titles.

### Shape & elevation
- Card radius 16–20px (18px typical); inner elements 10–14px; pills/buttons fully rounded (16–24px).
- Card shadow: `0 1px 2px rgba(0,0,0,.04), 0 8px 28px rgba(0,0,0,.05)`. AI-flavored cards tint the same shadow with rgba(94,92,230,…) and may add a `1.5px solid #DEDDF9` border.
- No borders on cards (hairline `#F0F0EE` dividers inside them only).

### Motion
- `hmdPulse`: opacity 1 → .25 → 1, 1.6–2s infinite — live dots only.
- Panel entry: 300ms ease slide-up + fade (`translateY(14px)`).
- Progress bars: `transition: width .4s ease`.

### Layout
- Web shell: sidebar 232px (white, 1px #E8E8E5 right border) + main content `max-width` 1080–1180px, padding 32px 40px. Give the shell `min-width: 1280px` so narrow viewports scroll instead of crushing.
- Grid gaps: 16px between cards, 20px between sections.
- Mobile: 390×844, cards 16px radius, floating tab bar (blurred white pill) with center green + capture button, min hit target 44px.

## Screens / Views

All sample data is for the persona **Arun Verma, 34** — prediabetes (HbA1c 5.8, improving) + stage-1 hypertension; meds metformin 500mg ×2, lisinopril 10mg, vitamin D; devices Apple Watch, Libre 3 CGM, Withings scale + BP cuff, Oura ring, Pi dispenser; 4y 2m of history, 128,443 observations.

### 1. Dashboard (`Web - Dashboard.dc.html`)
Status strip ("You're okay right now — 11 of 12 in range"), 4-card metric grid (live glucose deep-green tile + HR/BP/weight sparkline cards), today's medications with dispenser states, AI insights stack with confidence + evidence links, upcoming events, recent activity feed. FHIR: Observation, MedicationRequest, DetectedIssue.

### 2. Ingestion Suite (`Web - Ingestion Suite.dc.html`) — 3 sub-screens
- **1a Capture hub**: modal sheet (760px) over dimmed dashboard; 8 capture-method tiles (scan, photo of device screen, upload, manual, pair device, connect service, email-in, voice); footer promise "everything lands in the review queue."
- **1b Scan & confirm**: split view — document preview with green/amber OCR highlight regions; right rail of extracted observations (name, LOINC, editable value, unit, ref range, per-field confidence bar, range status). Amber flagged-field callout ("check the unit"). Privacy chip switches local (Tesseract/stays home) vs cloud (Anthropic/leaves device).
- **1c Review queue**: the gate into the record. Filter chips, queue cards (extracted doc, AI-read photo needing confirm, OAuth backfill, CSV import), inline conflict-reconciliation card (Watch vs Oura HR, device priority), "Approve N high-confidence" bulk action.

### 3. Devices (`Web - Devices.dc.html`)
Fleet health strip (streaming/synced/attention), roster cards with status dots (LIVE pulsing / SYNCED / AUTH EXPIRED), Libre 3 detail (deep-green live panel: big reading, trend arrow, target-band chart, TIR/sensor-day/signal/gaps stats), DeviceMetric table with calibration states, 4-stage ingest pipeline diagram (BLE → Bot → FHIR Observation → record).

### 4. AI Insights (`Web - AI Insights.dc.html`)
Open/Tracking/Resolved tabs, insight cards (severity, confidence bar, source count), evidence drawer for selected insight: chart with population ref band (gray) + dashed indigo "normal for me" band, "why this was flagged" statistical reasoning, 3 evidence source rows, Track/Not useful/Add note actions ("feedback tunes future flags"). Model card lists which engine runs each capability.

### 5. Labs (`Web - Labs.dc.html`)
HbA1c hero trend (8 draws over 3y, ref band, dashed AI forecast cone "✦ 5.4 BY OCT · conf 0.87"), four panel cards (Metabolic/Lipids/Kidney/Thyroid) with per-analyte range-position bars (dot on band), value color = status, trend note, source provenance footer.

### 6. Vitals (`Web - Vitals.dc.html`)
BP focus: sys/dia dual-line 90-day chart vs target band + personal baseline, 4 stat cards, AI morning-vs-evening pattern card (side-by-side avgs, "add to visit prep"), recent readings log with context + source (including an AI-read photo entry). Metric switcher: BP/Heart/Weight/Temp/SpO₂.

### 7. Data Explorer (`Web - Data Explorer.dc.html`)
Natural-language query bar ("parsed locally · Ollama"), overlay chart with removable signal chips, AI-noticed window (indigo tint region), correlation callout with honest caveat ("not proof of cause"), saved views list.

### 8. Medications (`Web - Medications.dc.html`)
Dark dispenser status banner (tray wedge counts, refill warning), active meds table with 30-day adherence heatstrips (30 tiny bars, green/red), "Is metformin working?" effect panel (HbA1c chart with therapy-start marker, before/after deltas), interactions checked, refills.

### 9. Timeline (`Web - Timeline.dc.html`)
Year density scrubber (bar chart 2022→now), filter chips, day-grouped event spine: time column, colored dot on vertical line, event cards with class tags (✦ AI, WATCH, REVIEWED).

### 10. Documents (`Web - Documents.dc.html`)
Email-to-inbox strip with pending item, category filter chips, 3-col grid of document cards: kind thumbnail (PDF/DICOM/CSV), extraction state ("6 OBS EXTRACTED" / "AWAITING REVIEW"), provenance line.

### 11. Assistant (`Web - Assistant.dc.html`)
Chat: user bubble dark, assistant card white with ✦ AI tag + "read N observations · processed locally" meta. **Every claim carries a numbered citation chip** linking to a SOURCES list (observation sets, care-plan entries, AI patterns). Inline mini-chart. Action chips (Add to visit prep / Show all readings / Wrong? Tell me). Composer footer: "Not medical advice… never writes to the record." Messages area scrolls (`overflow-y: auto`).

### 12. Privacy Vault (`Web - Privacy Vault.dc.html`)
Dark hero (contents counts, backup status, AES-256/LAN-only chips), **"What has ever left this device"** ledger (recipient, date, revoke/end-share actions), AI permissions per feature (local/cloud with toggles), full FHIR export card, time-boxed clinician shares.

### 13. AI Settings (`Web - AI Settings.dc.html`)
Two provider cards: **Local Ollama** (running, model, latency, "data leaves device: never", default) and **Cloud BYOK** — provider segmented picker (Anthropic/OpenAI/Custom endpoint), masked key field with Test button (state: `✓ Valid`), "stored in your OS keychain · never in the record, never in backups, never synced", monthly usage/cost, "Remove key & disable cloud" destructive action. Feature-routing table: per-feature ⌂ local / ☁ your key / off segmented control; footer: de-identification before send + boundary-ledger logging.

### 14. History Log (`Web - History Log.dc.html`)
Filterable audit log (All / ✦ AI Q&A / Uploads / Labs / Edits / Deletions — chips are stateful). Week-grouped rows: AI Q&A sessions (View/Delete), uploads (Open/Remove), lab approvals, corrections, cloud requests, deletion stubs. Right rail: **Edit panel** (new value, version history "v2 you · correction / v1 scan", Save as v2 — nothing is lost) and **Remove panel** (what's deleted, audit stub kept, purged from backups next cycle, red Delete permanently). Rules card summarizes edit/delete semantics per data type.

### 15. Onboarding (`Web - Onboarding.dc.html`) — 4 steps
3a Welcome (dark, promise, "Set up my vault"); 3b Keys (12-word recovery phrase grid, honest warning "there is no 'we'", print backup kit); 3c Connect sources (selectable cards, scopes shown before connect, "Skip — start empty"); 3d First import (progress bars per source, review-queue habit hook, "Go to my dashboard").

### 16. Clinician Share (`Web - Clinician Share.dc.html`)
Recipient-facing read-only page: dark banner (expiry countdown), patient header, share-scope strip ("everything else withheld by the patient"), patient's question callout, BP summary + morning/evening stats, labs table, adherence summary, PDF/FHIR download, self-destruct notice. AI content is marked "patient-run AI, included with the patient's consent."

### 17. Caretaker View (`Web - Caretaker View.dc.html`)
What a family caretaker sees of a relative's record (persona: Arun caring for his mother Sudha, 68, T2 diabetes). Sidebar care-circle switcher (You / Ma / Rohan, alert dots, stateful). Consent banner ("Ma shares with you" — shared areas green, withheld areas 🔒), locked nav items rendered #C9C9C5 with lock glyph. Actionable missed-dose alert (dispenser context, "Send gentle reminder"). Her-week panel: per-med 7-day adherence grids (taken #DDF2E8/✓, missed #F8DEDE/✕, late #FBF3E4/~). Care-circle roster with role pills (CARETAKER/ALERTS/CLINICIAN). Dark break-glass card: 24h emergency unlock, owner notified, permanently logged. "As a caretaker you can't" card. Amber context chip "Viewing Ma's vault · her device".

### 18. Access Control (`Web - Access Control.dc.html`)
The owner's mirror side, rendered as Sudha's vault (purple #3E2A50 context banner, first-person copy, slightly larger type). Expanded caretaker card with 6 **working scope toggles** (44×26 switch, track #0F8A63 on / #D9D9D5 off, summary line updates with count); collapsed cards for alerts-only and clinician members. "When to tell my family" alert-rule table with escalation ("Arun, then Priya") and an owner-declined rule ("OFF, my choice"). Emergency-access policy card (owner can turn off) and "Who looked, lately" access log. FHIR: AccessPolicy per member; AuditEvent for reads.

### 19. Dispenser Suite (`Web - Dispenser Suite.dc.html`) — 3 sub-screens

**Hardware model (from the device's patent figures)**: the dispenser is a lidded cylinder. Eight colour-rimmed, numbered trays stack on a central spindle; each tray is divided into 7 pie wedges, one wedge = one dose (mixed pills). At dose time the spindle rotates the right tray, today's wedge opens, pills fall through a cone funnel into a base tray sitting on a load cell (pickup detection). Mapping: one tray = one dose-time (Tray 1 morning · blue, Tray 2 evening · orange, Tray 3 night · purple, Tray 4 travel · teal, 5–8 spare); 7 wedges = Mon–Sun. Tray colours are a dedicated hardware palette — do NOT reuse data-class colors.
- **5a Hub & adherence**: dark device card with the spindle stack side-view (per-tray row: numbered colour ring, dose-time, 7 wedge chips showing remaining doses, state) beside a funnel → base-tray schematic (load cell) and sensor strip (load cell, bay camera, chime ring, LAN webhook). Adherence observations: 12-week heatmap (all-taken #0F8A63 / late #9BD9BF / partial #E5B9B9 / missed #D64545), timeliness histogram (on-time ±15m / 15–60m / 1–3h / missed, median delay + worst window), and a ✦ timing→outcome card pairing dose lateness with next-morning glucose. Dose-event log where every MedicationAdministration carries its verification method: ⚖ WEIGHT > ⌗ CAMERA > ✎ SELF.
- **5b Verify pills**: 4-step flow (lift tray → verify → count → return to spindle). Live lid-camera view: pills ringed green (#4FD6A6) when matched by the on-Pi vision model (shape · color · imprint), mismatches ringed amber with reason ("looks like 20 mg, wrong strength"). Safety invariant: **a tray cannot return to the spindle while a mismatched pill is inside** (button disabled with the reason as its label), with the reason as its label. Weight count cross-checked against camera; refill-date projection.
- **5c Dispense moment**: the dispenser's own screen (breathing ring animation, "Tray ready", combined meds + with-food guidance, tray-weight readout) beside the app's live dose card (both meds IN TRAY, Taken/Snooze/Skip, "or just pick it up — ⚖ logs it for you"), the user-configured escalation ladder (T+0 chime → T+15 phone → T+45 ask-why → T+2h base tray closes + logged missed → explicitly no family alert), and the resulting weight-verified observation note. Physical states strip: T−5 warm-up / T+0 fill / pickup / 2h retract.

### 20. Tray Filling Station (`Web - Cartridge Filling.dc.html`)
Dedicated filling UI. Left rail: the spindle stack — 8 tray cards (colour-rimmed disc side-view with number, name, wedge status), selected tray gets a 2px colour border. Main: colour-lock header (NFC-read confirmation), the tray rendered **from above as a 7-wedge SVG wheel** (donut wedges; verified = green fill/ring, filling-now = tray-colour highlight, empty = gray; day letters + ✓/now/— marks are HTML overlays absolutely positioned over the SVG — do NOT put dynamic text inside SVG <text>), per-wedge camera verification card (expected combo from schedule), weigh & slide-back card with a gating button (blocked while a wedge is unexpectedly empty, with an explicit "Sunday is intentional — skip it" override). Footer explains the refill event log + phone-guidance pattern ("the orange one, number 2").

### 21. Mobile (`Mobile - Screens.dc.html`) — 10 screens, 390×844
2a Today (status, live glucose, missed dose, floating tab bar with center ＋ capture); 2b Glucose detail (dark deep-green, big number, target-band chart, AI meal note); 2c Camera scan (viewfinder, corner brackets, live extraction toast "5 values found · 1 low conf", ⌂ local OCR); 2d Dose reminder (notification, dispenser state, log/dispense/skip actions, AI "why this matters" nudge). Parity set: 4a Review queue (swipe-to-approve, bulk high-confidence), 4b Insights with bottom-sheet evidence, 4c Assistant with cited answers, 4d Health hub (More tab — full nav parity with badges), 4e Caretaker (Ma's alert-first card, week strip, locked areas), 4f Vault (dark; stats, boundary ledger, export/backup, Face ID note).

### 22. Scan Flow Prototype (`Prototype - Scan Flow.dc.html`)
Working 4-step interaction: Capture → Extract (simulated progress with staged labels) → Confirm (Approve disabled until flagged unit confirmed) → Filed (provenance receipt, "left this device: nothing ⌂"). Clickable stepper for completed steps; reset. Use its state machine as the implementation spec.

## Interactions & Behavior
- **Review-queue invariant**: no ingested data enters the record without explicit user approval; approve actions are green, primary.
- **Approve gating**: approve buttons disable (gray #C9C9C5, not-allowed cursor) while any flagged field is unresolved.
- **AI feedback loop**: every insight offers Track / Dismiss ("Not useful") — copy states dismissal teaches the model.
- **Boundary notices**: before any cloud call, UI names the recipient and what's sent; all cloud events append to the Privacy Vault ledger.
- **Edits**: create new FHIR versions; prior versions listed and kept. **Deletes**: permanent for AI chats/journal (audit stub remains, purged from backups); documents removable with separate prompt for their extracted values.
- Hover: cards deepen shadow; tiles gain green border. Segmented controls: active = white bg + `0 1px 3px rgba(0,0,0,.08)`.
- Links: green #0F8A63, hover #0A6B4C, no underline; evidence/AI links indigo.

## State Management
- Global: patient record (FHIR via Medplum SDK), review-queue count (sidebar badge), open-insights count, vault stats, AI provider config + per-feature routing, live device subscriptions (Medplum `useSubscription` for CGM/dispenser).
- Per-screen state is enumerated in each file's logic class (filter indices, stepper state, unit-confirm flags, provider selection).

## Copy principle: no plumbing on the surface
User-facing copy never names backend mechanisms (Task, GraphQL, AccessPolicy, QuestionnaireResponse, $export…) — it says what happens in human words ("nothing enters without you", "access expires on its own", "logged as dispensed 19:00 · taken 19:07"). The mechanism mapping lives in ARCHITECTURE.md and belongs in code, tooltips, and developer docs — not in labels.

## FHIR Mapping (component → resource) — see ARCHITECTURE.md for the full backend design
MetricCard/TrendChart → Observation (targets → Goal) · LiveReadingTile → Observation + Subscription · AIScoreCard/AnomalyCard → RiskAssessment / DetectedIssue · MedScheduleRow → MedicationRequest + MedicationDispense + MedicationAdministration · review queue items → Task · DocumentCard → DocumentReference + Provenance · DeviceRosterCard → Device + DeviceMetric (via Medplum Agent) · ReconciliationCard → Task + provenance priority · manual entry / skip reasons → Questionnaire/QuestionnaireResponse · reminders & escalation → CommunicationRequest · edits → resource versioning · history log → AuditEvent · shares & care circle → ProjectMembership + AccessPolicy (break-glass Bot) · export → bulk $export · Explorer → GraphQL.

## Assets
No image assets. Icons are Unicode glyphs (◈ ♥ ⚗ ⊞ ✦ ☰ ⌸ ▤ ◌ ☾ ✎ ✉ ⇄ ◉ ⌚ ⚖ ⊕ ⌗ ⇪ ☁ ⌂) used as placeholders — replace with the codebase's icon set (e.g. Tabler icons, which ship with Mantine), preserving size (13–17px) and weight. Charts are hand-drawn SVG — implement with the codebase's chart library, preserving band/baseline/forecast layering.

## Files
- `ARCHITECTURE.md` — Medplum backend mapping: Agent topology, resource mapping per screen, Bot list, AccessPolicy sketches, invariants
- `HealMeDaily Design System v2.dc.html` — tokens, components, integrations catalog, dark mode
- `Index.dc.html` — links to every screen
- `Web - *.dc.html` — 20 web screens (listed above)
- `Mobile - Screens.dc.html` — 10 mobile screens
- `Prototype - Scan Flow.dc.html` — interactive flow spec
- `ios-frame.jsx` — device-frame wrapper used by the mobile canvas (design-tool scaffolding; ignore for implementation)
