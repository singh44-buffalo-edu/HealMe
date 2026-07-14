# HealMeDaily FHIR R4 mapping

Status: Phase 1 proposal — owner approval required before implementation  
FHIR version: R4 (4.0.1)  
Canonical base: `https://healmedaily.local/fhir/`

This is the canonical mapping from product concepts to the Medplum CDR. `codex.md` describes architecture and operating rules. A post-MVP change to this mapping requires owner approval and a migration plan.

## 1. Shared conventions

- The single person is one `Patient`. Patient-scoped clinical resources reference it through their standard `subject`, `patient`, or `for` field.
- Every repeatable external/business event gets a stable `identifier` so retries use conditional create/update instead of search-then-create.
- Standard codes are included only when verified. `CodeableConcept.text` and raw source values remain present.
- Project-local codes use absolute URLs below; they are not presented as LOINC, SNOMED, ICD, or RxNorm.
- Timestamps use FHIR date/time fields with offsets. Display uses the owner’s selected time zone.
- Records originating from import retain their source document and receive `Provenance` on finalization.
- Candidate extraction content is not created as a clinical resource before confirmation.

Proposed local systems:

| Purpose | URI |
| --- | --- |
| Business identifiers | `https://healmedaily.local/fhir/identifier/` |
| Observation codes | `https://healmedaily.local/fhir/CodeSystem/observation` |
| Adherence reasons | `https://healmedaily.local/fhir/CodeSystem/adherence-reason` |
| Device types/properties | `https://healmedaily.local/fhir/CodeSystem/device` |
| Ingestion task codes | `https://healmedaily.local/fhir/CodeSystem/ingestion-task` |
| Device assigned medication extension | `https://healmedaily.local/fhir/StructureDefinition/device-assigned-medication` |
| SupplyDelivery target cartridge extension | `https://healmedaily.local/fhir/StructureDefinition/supplydelivery-target-cartridge` |
| Life-critical medication flag extension | `https://healmedaily.local/fhir/StructureDefinition/medicationrequest-life-critical` |

## 2. Canonical domain map

| Domain | FHIR resource(s) | Key mapping |
| --- | --- | --- |
| Me | `Patient` | One configured Patient, found by explicit ID or stable identifier |
| Medication catalog | `Medication` | RxNorm coding when verified; raw label in `code.text` |
| Prescription/order and schedule | `MedicationRequest` | `subject`, `medicationReference`, `dosageInstruction.timing`, status/intent, raw SIG text |
| Self-reported medication without order evidence | `MedicationStatement` | Used by ingestion only when the source supports use/history but not an order |
| Taken/skipped/missed log | `MedicationAdministration` | One logical scheduled-dose event; `request` links the order; `device` links cartridge/dispenser when applicable |
| Check-in question bank | `Questionnaire` | Versioned form definition and coded items |
| Completed check-in | `QuestionnaireResponse` | `subject`, `questionnaire`, `authored`; source of truth for answers |
| Structured check-in answers | `Observation` | Bot-created only for selected scale/quantity answers; `derivedFrom` the response |
| Sleep, mood, energy, weight, vitals, activity | `Observation` | Point-in-time or period result; verified standard code where available, otherwise local code + raw value |
| Symptoms/side effects | `Observation`; `Condition` only when supported | Symptoms are usually Observations; a persistent diagnosis/problem is a Condition |
| Labs | `Observation` + `DiagnosticReport` | Report groups results; original units/reference range/raw label retained |
| Diagnoses | `Condition` | Verification/clinical status only when source supports it |
| Allergies | `AllergyIntolerance` | Substance/reaction and source certainty retained |
| Immunizations | `Immunization` | Status, occurrence, vaccine coding/raw display |
| Procedures | `Procedure` | Status, performed time, code/raw display |
| Visits | `Encounter` | Status/class/period; links providers and source documentation |
| Providers/facilities | `Practitioner`, `PractitionerRole`, `Organization` | Preserve source identifiers; do not merge solely by display name |
| Uploaded original | `DocumentReference` + `Binary` | Attachment URL references Binary; both link/security-scope to Patient |
| One extraction proposal | `Task` + proposal `Binary` | Task focuses source document; Binary contains `application/fhir+json` candidate, not an active clinical resource |
| Finalized extraction lineage | `Provenance` | `target` is finalized resource; `entity.what` points to source `DocumentReference`; method/confidence retained |
| Cartridge/dispenser | `Device` | Cartridge is an instance; future dispenser is parent Device; project extension references assigned Medication |
| Cartridge refill | `SupplyDelivery` + `Device` update | Event records medication/quantity; custom extension identifies target cartridge; transaction resets stock |
| Ingestion processing state | `Task` | `requested` → `in-progress` → `completed` or `rejected`/`failed` |
| Generated AI Health Review | `DocumentReference` + `Binary` (PDF) | Local type code `health-review`; window + generated-on retained; carries the not-medical-advice disclaimer; never a clinical source resource. Same shape for the deterministic data-only summary (no AI). |
| Vitals (BP/HR/temp/SpO2/glucose) | `Observation` category `vital-signs` | Verified LOINC: BP panel `85354-9` (components `8480-6`/`8462-4`), HR `8867-4`, temperature `8310-5`, SpO2 `59408-5`, glucose `2339-0`. Plausible-range validation at entry; no clinical thresholds until set with a clinician. |
| Question for prescriber | `Observation` local code `rx-question` | `valueString`; surfaced in AI review and data-only summary under "Questions for the prescriber". |
| Check-in extras (rested 1–5, stress 0–10) | `Observation` via Bot | Local codes `rested`, `stress`; questionnaire v1.1.0 items; superseded questionnaire versions are `retired` so `status=active` resolves uniquely. |

## 3. Medication and adherence

### Medication and MedicationRequest

`Medication` represents the product. `MedicationRequest` represents the owner’s prescription/order and schedule.

Required MVP relationships:

```text
MedicationRequest.subject             -> Patient/{id}
MedicationRequest.medicationReference -> Medication/{id}
MedicationAdministration.subject      -> Patient/{id}
MedicationAdministration.medicationReference -> Medication/{id}
MedicationAdministration.request      -> MedicationRequest/{id}
MedicationAdministration.device[]     -> Device/{cartridge-or-dispenser} (when applicable)
```

`MedicationRequest.dosageInstruction.text` retains the human-readable SIG. Structured `timing`, route, dose, and frequency are added only when supported by the source/user entry; no dose logic is inferred by AI.

Owner-confirmed (2026-07-13): life-critical medications exist in the regimen. A `MedicationRequest` may carry the `medicationrequest-life-critical` extension (`valueBoolean`), set explicitly by the owner in the medication config UI and never inferred. It drives display prominence only (per-med flag, missed-dose warnings sorted first, priority listing in the Health Review) — no dosing logic, no dispensing gate.

### One logical dose event

- Taken: `MedicationAdministration.status = completed`.
- User-skipped: `status = not-done`; `statusReason` uses local code `user-skipped` and clear text.
- User-marked missed: `status = not-done`; `statusReason` uses local code `user-marked-missed` and clear text.
- No log: no MedicationAdministration is created. The dashboard may compute “upcoming”, “due”, or “overdue/unlogged” from the MedicationRequest schedule.
- The MVP does not automatically convert absence into a persisted missed dose.

For scheduled doses, the stable identifier value is derived from the MedicationRequest identifier/ID and normalized scheduled occurrence time. A retry or a change from skipped to taken updates that same logical event with version checking rather than creating a duplicate. PRN/manual events use a client-generated event UUID that is retained across retries.

`effectiveDateTime` is when the dose was taken or explicitly marked not done. `meta.lastUpdated` remains the record-write time. Backdating changes `effectiveDateTime`, not server history.

These adherence semantics are medical-safety behavior and require owner sign-off before implementation.

## 4. Check-ins and quick observations

### Questionnaire flow

1. The frontend renders a versioned `Questionnaire` with Medplum’s Questionnaire component.
2. It saves a `QuestionnaireResponse` for the Patient with `authored` time and a stable daily/period identifier.
3. A tightly scoped Subscription invokes one Bot on create/update.
4. The Bot creates or updates only the selected structured `Observation` results.
5. Each Observation has `derivedFrom` pointing to the QuestionnaireResponse and a stable identifier derived from response ID + item `linkId`.

Do not configure SDC template extraction for the same form; this project uses the Bot strategy.

### Observation rules

- Weight uses verified LOINC `29463-7` and UCUM units (`[lb_av]` or `kg`) while retaining the entered display unit.
- Mood, energy, subjective sleep, and project-specific symptom scales use local codes until an appropriate standard code/instrument is verified.
- Numeric scales retain their integer/decimal value, scale meaning, and bounds in the Questionnaire item and display text.
- Sleep duration uses `effectivePeriod` for the sleep interval when start/end are known; otherwise use `effectiveDateTime` plus a duration value and raw entry.
- Symptoms use an Observation for a reported event/severity. Create a Condition only when the source represents an enduring diagnosis/problem.
- Medication-related symptoms may use `Observation.focus` to reference a Medication or MedicationRequest when the relationship is user/source asserted. The system does not infer causality.

## 5. Cartridge and future hardware model

FHIR R4 `Device` does not contain a native Medication reference. The proposed mapping therefore uses one narrow extension:

```text
Device.extension[url = device-assigned-medication].valueReference -> Medication/{id}
```

Cartridge fields:

| Product field | FHIR mapping |
| --- | --- |
| Cartridge ID | `Device.identifier` with stable project system/value |
| Name/slot | `Device.deviceName` and identifier |
| Type | `Device.type` local code `medication-cartridge` |
| Enabled | `Device.status = active`; disabled is `inactive` |
| Assigned medication | custom `valueReference` extension above |
| Capacity | `Device.property` local type `capacity`, `valueQuantity` count |
| Remaining stock | `Device.property` local type `remaining-count`, `valueQuantity` count |
| Low-stock threshold | `Device.property` local type `low-stock-threshold`, `valueQuantity` count |
| Future containing dispenser | `Device.parent -> Device/{dispenser}` |

Do not use `Device.patient` merely to express ownership; in R4 it means a device affixed to a Patient. AccessPolicy rules must therefore grant Device access explicitly.

A refill creates `SupplyDelivery(status=completed, patient=Patient, suppliedItem.itemReference=Medication, quantity=...)` with the target-cartridge extension, and updates the Device remaining count in one transaction. An administration plus decrement is also one transaction with `ifMatch` on the Device version. Inventory never decides whether a medication may be taken.

## 6. Document ingestion and review gate

### Original source

- Upload bytes through Medplum’s Binary/file API.
- `Binary.securityContext -> Patient/{id}`.
- `DocumentReference.subject -> Patient/{id}`.
- `DocumentReference.content.attachment.url -> Binary/{id}`.
- Preserve filename, media type, source date when known, hash, and source/import identifier.
- The original source is not overwritten by extraction output.

### Proposal representation

Each candidate clinical resource is stored as JSON in a separate proposal `Binary` with media type `application/fhir+json` and Patient security context. It is not POSTed to its clinical resource endpoint.

The corresponding `Task` uses:

```text
Task.status = requested | in-progress | completed | rejected | failed
Task.intent = proposal
Task.code = local code review-ingestion-proposal
Task.for -> Patient/{id}
Task.focus -> DocumentReference/{source-id}
Task.input(candidate) -> Binary/{proposal-id}
Task.input(confidence) -> decimal when available
Task.input(raw-excerpt) -> source excerpt when useful
Task.output(final-resource) -> confirmed Resource/{id} after completion
```

Confirming a proposal performs one transaction:

1. Create the validated clinical target resource.
2. Create `Provenance` targeting it and naming the source DocumentReference, extraction method/provider, time, and confidence.
3. Update the Task to `completed` with output reference.

Rejecting sets the Task to `rejected`; it creates no clinical target resource. Corrections update the candidate payload or build the confirmed resource from corrected fields before finalization. AI/OCR never bypasses this gate.

## 7. Idempotency and provenance identifiers

Representative identifier systems:

| Resource/event | Identifier system suffix | Stable value basis |
| --- | --- | --- |
| Patient seed | `patient` | configured personal identifier |
| Medication | `medication` | verified source ID or normalized user catalog UUID |
| MedicationRequest | `medication-request` | source prescription ID or project UUID |
| Scheduled administration | `medication-administration` | request + scheduled occurrence |
| Questionnaire | canonical `url` + `version` | form identity/version |
| Daily response | `questionnaire-response` | patient + questionnaire version + local period |
| Derived Observation | `questionnaire-observation` | response ID + item linkId |
| Quick Observation | `quick-observation` | client event UUID |
| Cartridge | `device` | durable cartridge UUID/slot identity |
| Refill | `supply-delivery` | client event UUID |
| Source document | `document` | source-system ID or content hash/import UUID |
| Proposal Task | `ingestion-task` | source document + candidate ordinal/type/hash |

Imported identifiers from hospitals or health apps retain their original `system` and `value`; project identifiers supplement rather than replace them.

## 8. Dashboard read model

Dashboards are projections over FHIR search results, not stored aggregates in another database.

- Adherence: bounded MedicationAdministration searches by Patient, time window, status, medication/request, and device; schedules from active MedicationRequests.
- Health overview: bounded Observation searches by Patient, code, date, `_sort`, and `_count`; recent QuestionnaireResponses only when the original answers are needed.
- Cartridge alerts: bounded Device search by cartridge type/status. The cartridge count is intentionally small, so parsing the returned Device properties in the UI is acceptable.
- Labs: DiagnosticReport searches with included/referenced Observations when appropriate.

Exact search parameter names are checked against the running R4 server before implementation. All searches paginate and apply server-side bounds.

## 9. Deliberately excluded mappings

- No side-database tables for clinical facts, embeddings, dashboard aggregates, or ingestion state.
- No AI-created Condition, MedicationRequest, allergy, or regimen change without explicit confirmation.
- No persisted “missed” dose inferred only from elapsed time.
- No use of `Attachment.data` for uploaded PDFs/images.
- No custom resource type when a standard FHIR R4 resource plus a narrow extension is sufficient.
- No `Device.patient` misuse for cartridge ownership.

