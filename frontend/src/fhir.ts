/**
 * FHIR helpers for the HealMeDaily frontend — the heart of the app's data
 * layer. Canonical resource shapes live in FHIR-MAPPING.md (read §3
 * meds/adherence, §7 identifiers, §8 dashboard read model before changing
 * anything here).
 *
 * Where this sits: every page component (Adherence, Overview, Check-in, …)
 * calls these helpers with the MedplumClient obtained from useMedplum().
 * This module talks straight to the Medplum FHIR REST API — there is no app
 * server in between and no side database; dashboards are projections over
 * bounded FHIR searches, recomputed at render time.
 *
 * Invariants enforced here:
 * - Every write is idempotent (stable business identifier + conditional
 *   create / update-in-place) so retries and double-taps never double-log.
 * - Dose-slot identity: one logical scheduled dose = identifier value
 *   `{request-slug}-{date}T{HH:MM}` (see slotIdentValue). Taken → skipped →
 *   taken all rewrite that ONE MedicationAdministration.
 * - "No log ⇒ no resource": a dose the user never acted on has NO
 *   MedicationAdministration. Dashboards compute due/overdue/unlogged from
 *   the MedicationRequest schedule; absence is never persisted as "missed"
 *   (owner-approved medical-safety rule — FHIR-MAPPING §3 and §12).
 * - All searches are server-side filtered and bounded (`_count`, date
 *   ranges) — never fetch-all-and-filter-in-JS (CLAUDE.md §5 Search).
 */

import { MedplumClient } from '@medplum/core';
import type {
  Device,
  Medication,
  MedicationAdministration,
  MedicationRequest,
  Patient,
  Questionnaire,
  QuestionnaireResponse,
  Resource,
  Task,
} from '@medplum/fhirtypes';

// Project-local systems for identifiers, CodeSystems and extensions
// (FHIR-MAPPING §1). These URLs are IDENTITY, not locations — never "fix"
// them to a resolvable host, and never present local codes as LOINC/SNOMED.
export const BASE = 'https://healmedaily.local/fhir';
export const IDENT = `${BASE}/identifier`;
export const CS_OBS = `${BASE}/CodeSystem/observation`;
export const CS_ADHERENCE = `${BASE}/CodeSystem/adherence-reason`;
export const CS_DEVICE = `${BASE}/CodeSystem/device`;
// Owner-set only, never inferred; drives display prominence, never dose
// logic (owner decision 2026-07-13, CLAUDE.md §8).
export const EXT_LIFE_CRITICAL = `${BASE}/StructureDefinition/medicationrequest-life-critical`;
export const EXT_DEVICE_MED = `${BASE}/StructureDefinition/device-assigned-medication`;
export const EXT_SUPPLY_TARGET = `${BASE}/StructureDefinition/supplydelivery-target-cartridge`;
export const Q_URL = `${BASE}/Questionnaire/daily-check-in`;
export const EXT_CADENCE = `${BASE}/StructureDefinition/questionnaire-cadence`;
export const CS_TASK = `${BASE}/CodeSystem/task`;
export const QR_IDENT_SYSTEM = `${IDENT}/questionnaire-response`;
// Standard terminologies — used only with VERIFIED codes (CLAUDE.md §3).
export const OBS_CATEGORY = 'http://terminology.hl7.org/CodeSystem/observation-category';
export const LOINC = 'http://loinc.org';
export const UCUM = 'http://unitsofmeasure.org';
// system|value search token for the one-and-only owner Patient (seeded).
export const PATIENT_IDENT = `${IDENT}/patient|healmedaily-user`;

// Identifier system for dose events — one value per logical scheduled dose.
const ADMIN_IDENT_SYSTEM = `${IDENT}/medication-administration`;

/**
 * How long after its scheduled time an unlogged dose stays merely "due"
 * before dashboards escalate it to "overdue" (red). Display urgency ONLY:
 * crossing the threshold never writes anything — absence of a log is never
 * persisted as a missed dose (FHIR-MAPPING §3/§12). 90 min encodes a
 * realistic "with breakfast / before bed" flexibility window, not a
 * clinical rule; changing it is adherence-display behavior → ask the owner.
 */
export const OVERDUE_GRACE_MINUTES = 90;

// ---------------------------------------------------------------------------

/**
 * UI projection of one cartridge `Device` (type medication-cartridge,
 * FHIR-MAPPING §5). Counts are unpacked from Device.property; `low` is
 * derived (remaining <= threshold) and display-only — inventory NEVER gates
 * whether a med may be taken.
 */
export interface CartridgeInfo {
  device: Device;
  name: string;
  enabled: boolean;
  /** Literal `Medication/{id}` reference from the device-assigned-medication extension. */
  medicationRef?: string;
  capacity?: number;
  remaining?: number;
  lowThreshold?: number;
  low: boolean;
}

/**
 * One active medication as the UI sees it: the MedicationRequest joined with
 * its Medication (display name), SIG text, life-critical flag, scheduled
 * times, and the enabled cartridge assigned to the same Medication (if any).
 */
export interface MedInfo {
  request: MedicationRequest;
  name: string;
  instructions: string;
  /** Owner-set medicationrequest-life-critical extension: sorts missed-dose
   * warnings first and flags the med — display prominence only, no dose logic. */
  lifeCritical: boolean;
  /** dosageInstruction.timing.repeat.timeOfDay — FHIR `time` values always
   * carry seconds ("09:00:00", never "09:00"; see CLAUDE.md §9 gotchas). */
  times: string[]; // HH:MM:SS
  cartridge?: CartridgeInfo;
  /** First day this request is in effect (authoredOn, else record creation).
   * Bounds historical slot generation so a med added today does not
   * retroactively rewrite past days' adherence. */
  startDate: string;
}

/** The single owner Patient, found by its stable seed identifier (this is a
 * one-patient app — there is no patient picker anywhere). Resolves undefined
 * until `make seed` has run; callers treat that as "not set up yet". */
export function getPatient(medplum: MedplumClient): Promise<Patient | undefined> {
  return medplum.searchOne('Patient', { identifier: PATIENT_IDENT });
}

// One numeric Device.property by local code (capacity / remaining-count /
// low-stock-threshold — FHIR-MAPPING §5 cartridge fields).
function deviceProp(device: Device, code: string): number | undefined {
  const prop = device.property?.find((p) => p.type?.coding?.some((c) => c.code === code));
  return prop?.valueQuantity?.[0]?.value;
}

/** Flatten a cartridge Device into CartridgeInfo (read-only projection). */
export function toCartridgeInfo(device: Device): CartridgeInfo {
  const capacity = deviceProp(device, 'capacity');
  const remaining = deviceProp(device, 'remaining-count');
  const lowThreshold = deviceProp(device, 'low-stock-threshold');
  return {
    device,
    name: device.deviceName?.[0]?.name ?? 'Cartridge',
    enabled: device.status === 'active',
    medicationRef: device.extension?.find((e) => e.url === EXT_DEVICE_MED)?.valueReference?.reference,
    capacity,
    remaining,
    lowThreshold,
    low: remaining !== undefined && lowThreshold !== undefined && remaining <= lowThreshold,
  };
}

/** All cartridge Devices, any status (disabled ones still render, grayed).
 * The fleet is intentionally tiny, so one bounded search + client-side
 * property parsing is acceptable here (FHIR-MAPPING §8). */
export async function loadCartridges(medplum: MedplumClient): Promise<CartridgeInfo[]> {
  const devices = await medplum.searchResources('Device', {
    type: `${CS_DEVICE}|medication-cartridge`,
    _count: '50',
  });
  return devices.map(toCartridgeInfo);
}

/**
 * Every ACTIVE MedicationRequest joined with its Medication and assigned
 * cartridge — the med list all adherence surfaces build on. Uses
 * `_include=MedicationRequest:medication` so it is one round trip (plus the
 * cartridge fleet). Stopped/inactive meds vanish from dashboards; their
 * historical MedicationAdministrations remain untouched in the record.
 */
export async function loadMeds(medplum: MedplumClient): Promise<MedInfo[]> {
  const bundle = await medplum.search('MedicationRequest', {
    status: 'active',
    _include: 'MedicationRequest:medication',
    _count: '100',
  });
  const medications = new Map<string, Medication>();
  const requests: MedicationRequest[] = [];
  for (const entry of bundle.entry ?? []) {
    // _include mixes Medication resources into a Bundle typed as MedicationRequest
    const res = entry.resource as Resource | undefined;
    if (res?.resourceType === 'Medication') medications.set(res.id as string, res);
    if (res?.resourceType === 'MedicationRequest') requests.push(res);
  }
  const cartridges = await loadCartridges(medplum);

  return requests.map((request) => {
    const medId = request.medicationReference?.reference?.split('/')[1];
    const medication = medId ? medications.get(medId) : undefined;
    const dosage = request.dosageInstruction?.[0];
    return {
      request,
      name: medication?.code?.text ?? 'Unnamed medication',
      instructions: dosage?.text ?? '',
      lifeCritical:
        request.extension?.some((e) => e.url === EXT_LIFE_CRITICAL && e.valueBoolean) ?? false,
      times: dosage?.timing?.repeat?.timeOfDay ?? [],
      cartridge: cartridges.find(
        (c) => c.enabled && c.medicationRef === request.medicationReference?.reference
      ),
      // authoredOn is the clinical start anchor; fall back to record creation
      // converted to the LOCAL calendar date (a raw UTC slice can land on
      // "tomorrow" and suppress today's doses).
      startDate: request.authoredOn
        ? request.authoredOn.slice(0, 10)
        : request.meta?.lastUpdated
          ? localDateString(new Date(request.meta.lastUpdated))
          : '',
    };
  });
}

// --- Dose slots & logging ---------------------------------------------------

/**
 * One expected dose occurrence ("slot"): a (medication, date, time-of-day)
 * triple computed from the schedule — NOT a stored resource. `identValue` is
 * the stable identity that links the slot to its MedicationAdministration,
 * if the user ever logged one ("no log ⇒ no resource").
 */
export interface DoseSlot {
  med: MedInfo;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM:SS
  identValue: string;
  /** Slot time as a Date in the browser's LOCAL timezone (wall-clock dosing). */
  scheduled: Date;
}

// The per-request half of the slot identity: the request's local business
// identifier (stable across export/reimport), falling back to server id.
function requestSlugBase(request: MedicationRequest): string {
  const local = request.identifier?.find((i) => i.system === `${IDENT}/medication-request`);
  return local?.value ?? (request.id as string);
}

/**
 * THE dose-slot identity scheme: `{request-slug}-{date}T{HH:MM}`.
 * Seconds are deliberately dropped — slot identity is minute-grained even
 * though FHIR `time` values carry seconds. This is the identifier value in
 * the `medication-administration` system (FHIR-MAPPING §7, "request +
 * scheduled occurrence"). The frontend, the Pi dispenser scheduler and the
 * reminders bot all derive this SAME value, so a retry, a correction, or a
 * different writer for the same slot converges on ONE
 * MedicationAdministration instead of creating duplicates.
 */
export function slotIdentValue(med: MedInfo, date: string, time: string): string {
  return `${requestSlugBase(med.request)}-${date}T${time.slice(0, 5)}`;
}

/**
 * Calendar date (YYYY-MM-DD) in the browser's LOCAL timezone. Deliberately
 * not `toISOString().slice(0, 10)`: a UTC slice taken near midnight lands on
 * the wrong day, which would shift dose slots, period identifiers and
 * adherence stats by one day.
 */
export function localDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Expand the schedules into concrete slots for one calendar date, sorted by
 * time of day. Days before a med's startDate yield no slots — a med added
 * today must not rewrite past days as "unlogged". Pure function; the same
 * inputs always regenerate identical identValues.
 */
export function slotsForDate(meds: MedInfo[], date: string): DoseSlot[] {
  const slots: DoseSlot[] = [];
  for (const med of meds) {
    if (med.startDate && date < med.startDate) {
      continue; // med did not exist yet — no historical slots
    }
    for (const time of med.times) {
      slots.push({
        med,
        date,
        time,
        identValue: slotIdentValue(med, date, time),
        scheduled: new Date(`${date}T${time}`),
      });
    }
  }
  return slots.sort((a, b) => a.time.localeCompare(b.time));
}

/**
 * Dose events logged in the trailing `days` window. Matched to slots by
 * identifier (adminForSlot), never by fuzzy timestamp comparison.
 * Server-side date filter + `_count=1000` (Medplum's hard page max) keeps
 * this a single bounded request — a much longer window would need
 * searchResourcePages.
 */
export async function loadAdmins(
  medplum: MedplumClient,
  days: number
): Promise<MedicationAdministration[]> {
  const start = new Date();
  start.setDate(start.getDate() - days);
  return medplum.searchResources('MedicationAdministration', {
    'effective-time': `ge${localDateString(start)}`,
    _count: '1000',
  });
}

/** The logged event for a slot, if any — strict identifier match only.
 * `undefined` means unlogged: a real, meaningful state (no resource exists),
 * not an error. */
export function adminForSlot(
  admins: MedicationAdministration[],
  slot: DoseSlot
): MedicationAdministration | undefined {
  return admins.find((a) =>
    a.identifier?.some((i) => i.system === ADMIN_IDENT_SYSTEM && i.value === slot.identValue)
  );
}

/** The three explicit user actions on a slot. "Did nothing" is deliberately
 * not an action — it leaves no resource behind (FHIR-MAPPING §3). */
export type DoseAction = 'taken' | 'skipped' | 'missed';

// statusReason codings for not-done outcomes (adherence-reason CodeSystem):
// skipped = deliberate choice, missed = forgot/unable. Both user-asserted.
const REASON_CODE: Record<Exclude<DoseAction, 'taken'>, { code: string; display: string }> = {
  skipped: { code: 'user-skipped', display: 'Skipped by user' },
  missed: { code: 'user-marked-missed', display: 'Marked missed by user' },
};

/**
 * Log (or change) one logical dose event. Idempotent per (request, slot):
 * the slot identifier makes retries, double-taps and corrections converge on
 * a single MedicationAdministration — update-in-place, never a duplicate.
 *
 * Writes: MedicationAdministration `completed` (taken) or `not-done` +
 * statusReason (skipped/missed), plus a display-only cartridge
 * remaining-count adjustment when the med has one assigned.
 *
 * `takenAt` supports backdating: clinical time lives in effectiveDateTime
 * while meta.lastUpdated keeps the record-write time (CLAUDE.md §6).
 * Skips/misses pin effectiveDateTime to the scheduled slot time instead.
 */
export async function logDose(
  medplum: MedplumClient,
  patientId: string,
  slot: DoseSlot,
  action: DoseAction,
  takenAt?: Date
): Promise<MedicationAdministration> {
  // One identifier search decides create-vs-correct for this slot.
  const existing = await medplum.searchOne('MedicationAdministration', {
    identifier: `${ADMIN_IDENT_SYSTEM}|${slot.identValue}`,
  });

  const base: MedicationAdministration = {
    resourceType: 'MedicationAdministration',
    status: action === 'taken' ? 'completed' : 'not-done',
    subject: { reference: `Patient/${patientId}` },
    medicationReference: slot.med.request.medicationReference,
    request: { reference: `MedicationRequest/${slot.med.request.id}` },
    effectiveDateTime:
      action === 'taken' ? (takenAt ?? new Date()).toISOString() : slot.scheduled.toISOString(),
    identifier: [{ system: ADMIN_IDENT_SYSTEM, value: slot.identValue }],
  };
  if (action !== 'taken') {
    base.statusReason = [
      { coding: [{ system: CS_ADHERENCE, ...REASON_CODE[action] }] },
    ];
  }
  if (action === 'taken' && slot.med.cartridge) {
    base.device = [{ reference: `Device/${slot.med.cartridge.device.id}` }];
  }

  // Capture the prior state first — the inventory delta below depends on the
  // TRANSITION (taken↔not-taken), not on the final status alone.
  const wasTaken = existing?.status === 'completed';
  const result = existing
    ? await medplum.updateResource({ ...base, id: existing.id, meta: existing.meta })
    : // Conditional create: concurrent calls (double-tap, second tab) resolve
      // to one resource instead of duplicates.
      await medplum.createResourceIfNoneExist(base, `identifier=${ADMIN_IDENT_SYSTEM}|${slot.identValue}`);

  // Display-only inventory (never gates taking a med): decrement on a new
  // "taken", restore when a taken dose is corrected to skipped/missed.
  // Fresh read + clamp to [0, capacity]; no ifMatch here (unlike the
  // dispenser's decrement path) because a lost race only skews a cosmetic
  // count that the next refill resets.
  const delta = action === 'taken' && !wasTaken ? -1 : action !== 'taken' && wasTaken ? +1 : 0;
  if (delta !== 0 && slot.med.cartridge?.remaining !== undefined) {
    const cart = slot.med.cartridge;
    const device = await medplum.readResource('Device', cart.device.id as string);
    const prop = device.property?.find((p) =>
      p.type?.coding?.some((c) => c.code === 'remaining-count')
    );
    const capacity =
      device.property
        ?.find((p) => p.type?.coding?.some((c) => c.code === 'capacity'))
        ?.valueQuantity?.[0]?.value ?? Number.MAX_SAFE_INTEGER;
    const current = prop?.valueQuantity?.[0]?.value;
    if (prop?.valueQuantity?.[0] && current !== undefined) {
      const next = Math.min(Math.max(current + delta, 0), capacity);
      if (next !== current) {
        prop.valueQuantity[0].value = next;
        await medplum.updateResource(device);
      }
    }
  }
  return result;
}

// --- Check-in cadence engine (spec §11-lite: D / W / M periods) ---------------

/** Cadence codes from the questionnaire-cadence extension (owner spec §11):
 * Daily / Weekly / Monthly check-in periods. */
export type Cadence = 'D' | 'W' | 'M';

export const CADENCE_LABEL: Record<Cadence, string> = { D: 'Daily', W: 'Weekly', M: 'Monthly' };

/** Local Monday of the week containing d — the weekly period key. */
export function mondayOf(d: Date): string {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return localDateString(x);
}

/** Stable per-period identifier value: retries and resubmits within the same
 * period update the same QuestionnaireResponse instead of duplicating.
 * Formats (FHIR-MAPPING §2): `{key}-{YYYY-MM-DD}` (D), `{key}-week-{monday}`
 * (W), `{key}-month-{YYYY-MM}` (M) — all derived from LOCAL calendar time. */
export function periodIdentValue(questionnaireKey: string, cadence: Cadence, today: Date): string {
  if (cadence === 'D') return `${questionnaireKey}-${localDateString(today)}`;
  if (cadence === 'W') return `${questionnaireKey}-week-${mondayOf(today)}`;
  return `${questionnaireKey}-month-${localDateString(today).slice(0, 7)}`;
}

/** One due-panel entry: a cadence-tagged Questionnaire plus this period's
 * identifier and existing response (present ⇒ already done, still editable). */
export interface CheckinDef {
  questionnaire: Questionnaire;
  cadence: Cadence;
  periodIdent: string;
  existing?: QuestionnaireResponse;
}

/** Every active questionnaire carrying a cadence tag, with its current-period
 * response (if any) — the "what is due now" list, sorted D → W → M.
 * Superseded questionnaire versions are `retired` in the CDR, so filtering on
 * status=active resolves each form uniquely (FHIR-MAPPING §2). */
export async function loadCheckins(medplum: MedplumClient, today: Date = new Date()): Promise<CheckinDef[]> {
  const questionnaires = await medplum.searchResources('Questionnaire', { status: 'active', _count: '50' });
  const defs: CheckinDef[] = [];
  for (const questionnaire of questionnaires) {
    const cadence = questionnaire.extension?.find((e) => e.url === EXT_CADENCE)?.valueCode as
      | Cadence
      | undefined;
    if (!cadence || !questionnaire.url) continue;
    const key = questionnaire.url.split('/').pop() as string;
    const periodIdent = periodIdentValue(key, cadence, today);
    const existing = await medplum.searchOne('QuestionnaireResponse', {
      identifier: `${QR_IDENT_SYSTEM}|${periodIdent}`,
    });
    defs.push({ questionnaire, cadence, periodIdent, existing });
  }
  const order: Cadence[] = ['D', 'W', 'M'];
  return defs.sort((a, b) => order.indexOf(a.cadence) - order.indexOf(b.cadence));
}

// --- Follow-up tasks (event-triggered cadence) --------------------------------

/**
 * Open symptom follow-up Tasks (status=requested, newest first) — created by
 * the symptom→follow-up bot with idempotent identifiers (FHIR-MAPPING §2).
 * Display-only workflow: resolution is always the user's action, never
 * automatic escalation or clinical logic.
 */
export function loadFollowUps(medplum: MedplumClient): Promise<Task[]> {
  return medplum.searchResources('Task', {
    status: 'requested',
    code: `${CS_TASK}|symptom-follow-up`,
    _sort: '-_lastUpdated',
    _count: '50',
  });
}

/** Mark a follow-up handled (status flip only; re-running is harmless). */
export async function completeFollowUp(medplum: MedplumClient, task: Task): Promise<void> {
  await medplum.updateResource({ ...task, status: 'completed' });
}

// --- Adherence aggregates ----------------------------------------------------

/** Whole-day adherence classification. 'unlogged' (scheduled, nothing
 * recorded) is deliberately distinct from 'none-taken' (explicit skips or
 * misses): under no-log⇒no-resource, silence and refusal are different facts
 * and must never be conflated in a dashboard. */
export type DayStatus = 'all-taken' | 'partial' | 'none-taken' | 'unlogged' | 'no-doses';

/** Per-day rollup consumed by the calendar Heatmap and adherence stats. */
export interface DaySummary {
  date: string;
  scheduled: number;
  taken: number;
  notDone: number;
  status: DayStatus;
}

/**
 * Roll up the trailing `days` calendar days (oldest first, ending `today`)
 * by regenerating each day's slots and matching logged admins by identifier.
 * Pure function of its inputs — tests pass a fixed `today`.
 */
export function summarizeDays(
  meds: MedInfo[],
  admins: MedicationAdministration[],
  days: number,
  today: Date = new Date()
): DaySummary[] {
  const out: DaySummary[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const date = localDateString(d);
    const slots = slotsForDate(meds, date);
    let taken = 0;
    let notDone = 0;
    for (const slot of slots) {
      const admin = adminForSlot(admins, slot);
      if (admin?.status === 'completed') taken++;
      else if (admin?.status === 'not-done') notDone++;
    }
    let status: DayStatus = 'no-doses';
    if (slots.length > 0) {
      if (taken === slots.length) status = 'all-taken';
      else if (taken > 0) status = 'partial';
      else if (notDone > 0) status = 'none-taken';
      else status = 'unlogged';
    }
    out.push({ date, scheduled: slots.length, taken, notDone, status });
  }
  return out;
}

export interface AdherenceStats {
  taken: number;
  notDone: number;
  pct: number | null; // of logged doses
  streak: number; // consecutive fully-taken days (ending today or yesterday)
  perMed: { med: MedInfo; taken: number; notDone: number; pct: number | null }[];
}

/**
 * Adherence stats computed from the SAME slot model as the day summaries, so
 * the percentage, per-med bars, calendar and streak always describe the same
 * window (slot-identifier matched — duplicates and out-of-window admins are
 * never double counted). `streakDays` (defaults to `daySummaries`) may be a
 * longer window so the streak is not capped by the stats window.
 */
export function adherenceStats(
  meds: MedInfo[],
  admins: MedicationAdministration[],
  daySummaries: DaySummary[],
  streakDays?: DaySummary[]
): AdherenceStats {
  const pctOf = (taken: number, notDone: number) => {
    const logged = taken + notDone;
    return logged ? Math.round((100 * taken) / logged) : null;
  };

  const perMedCounts = new Map<string, { taken: number; notDone: number }>();
  let taken = 0;
  let notDone = 0;
  for (const day of daySummaries) {
    for (const med of meds) {
      const counts = perMedCounts.get(med.request.id as string) ?? { taken: 0, notDone: 0 };
      for (const slot of slotsForDate([med], day.date)) {
        const admin = adminForSlot(admins, slot);
        if (admin?.status === 'completed') {
          counts.taken++;
          taken++;
        } else if (admin?.status === 'not-done') {
          counts.notDone++;
          notDone++;
        }
      }
      perMedCounts.set(med.request.id as string, counts);
    }
  }

  const perMed = meds.map((med) => {
    const counts = perMedCounts.get(med.request.id as string) ?? { taken: 0, notDone: 0 };
    return { med, ...counts, pct: pctOf(counts.taken, counts.notDone) };
  });

  let streak = 0;
  const chronological = [...(streakDays ?? daySummaries)].reverse(); // today first
  for (let i = 0; i < chronological.length; i++) {
    const day = chronological[i];
    if (i === 0 && day.status !== 'all-taken') {
      if (day.notDone > 0) break; // an explicit skip/miss today ends the streak now
      continue; // today merely not finished yet — judge from yesterday
    }
    if (day.status === 'all-taken') streak++;
    else if (day.status !== 'no-doses') break;
  }

  return { taken, notDone, pct: pctOf(taken, notDone), streak, perMed };
}
