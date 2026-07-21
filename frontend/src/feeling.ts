/**
 * Momentary feeling checks — "How am I feeling right now?"
 * (FHIR-MAPPING.md §4 "Momentary feeling checks", added 2026-07-21).
 *
 * What a momentary check IS: one or two quick Observations using the SAME
 * local codes the daily check-in and Quick add already write (`mood`, and —
 * only when stated — `energy`), so Trends/Overview/Correlations pick the
 * entries up with zero new read model. What distinguishes them is only
 * `meta.tag feeling-now`; values the AI parsed out of a dictation (and the
 * user did not edit) additionally carry `meta.tag ai-parsed`.
 *
 * Cadence is CLIENT-LOCAL by design (mapping §4: web due-card, no new server
 * resources — the Phase 9 reminders-runner stays dose-only): the off/2×/3×/4×
 * preference lives in localStorage and only drives when the Overview card
 * shows its DUE state. Dueness is derived, never stored — same philosophy as
 * check-in periods and dose slots ("no log ⇒ no resource").
 *
 * Everything except the two client calls at the bottom is a pure function so
 * feeling.test.ts can pin the behavior. Deliberately NOT in fhir.ts: that
 * module's dose-engine half is behaviorally mirrored by the iOS DoseEngine
 * (change-in-lockstep contract, CLAUDE.md §2) — new observation-write logic
 * stays out of its blast radius.
 */

import { MedplumClient } from '@medplum/core';
import type { Coding, Observation } from '@medplum/fhirtypes';
import { CS_OBS, IDENT, OBS_CATEGORY, TAGS, getPatient } from './fhir';

// Identifier system for quick observations (FHIR-MAPPING §7: "Quick
// Observation" → client event UUID). Same system LogPage stamps on manual
// quick-add entries — momentary checks are quick observations too.
export const QUICK_IDENT = `${IDENT}/quick-observation`;

/** meta.tag marking a momentary spot check (vs the daily questionnaire). */
export const FEELING_TAG: Coding = {
  system: TAGS,
  code: 'feeling-now',
  display: 'Momentary check-in',
};

/** meta.tag for values an AI provider parsed from dictation. Anything
 * carrying it MUST render with the ✦ AI label (mapping §4 / CLAUDE.md §2). */
export const AI_PARSED_TAG: Coding = {
  system: TAGS,
  code: 'ai-parsed',
  display: 'AI-parsed from dictation',
};

// ---------------------------------------------------------------------------
// Cadence preference (client-local)
// ---------------------------------------------------------------------------

/** How often the Overview card prompts. 'off' hides the card entirely. */
export type FeelingCadence = 'off' | '2x' | '3x' | '4x';

export const FEELING_CADENCE_KEY = 'hmd.feeling-cadence';

const PER_DAY: Record<FeelingCadence, number> = { off: 0, '2x': 2, '3x': 3, '4x': 4 };

export const FEELING_CADENCE_LABEL: Record<FeelingCadence, string> = {
  off: 'Off',
  '2x': '2× / day',
  '3x': '3× / day',
  '4x': '4× / day',
};

/** Read the cadence preference; anything unreadable/unknown degrades to 'off'
 * (prompting is opt-in — a broken storage must never start nagging). */
export function loadFeelingCadence(): FeelingCadence {
  try {
    const v = localStorage.getItem(FEELING_CADENCE_KEY);
    return v === '2x' || v === '3x' || v === '4x' ? v : 'off';
  } catch {
    return 'off';
  }
}

/** Persist the cadence preference. Client-local only — never in the record. */
export function saveFeelingCadence(cadence: FeelingCadence): void {
  try {
    localStorage.setItem(FEELING_CADENCE_KEY, cadence);
  } catch {
    // storage unavailable — the preference just won't stick
  }
}

// ---------------------------------------------------------------------------
// Due logic (pure)
// ---------------------------------------------------------------------------

/**
 * The current prompt window: cadence N splits the LOCAL calendar day into N
 * equal windows anchored at local midnight (2× → 12 h, 3× → 8 h, 4× → 6 h).
 * Windows are wall-clock derived, so on DST-change days the last window
 * stretches/shrinks with the day (the index is clamped) — a display nicety,
 * never a data concern. Returns null when the cadence is off.
 */
export function feelingWindow(
  cadence: FeelingCadence,
  now: Date
): { start: Date; end: Date } | null {
  const n = PER_DAY[cadence];
  if (!n) {
    return null;
  }
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const windowMs = (24 * 60 * 60 * 1000) / n;
  const idx = Math.min(
    Math.max(Math.floor((now.getTime() - midnight.getTime()) / windowMs), 0),
    n - 1
  );
  const start = new Date(midnight.getTime() + idx * windowMs);
  return { start, end: new Date(start.getTime() + windowMs) };
}

/**
 * Is a momentary check due right now? True when the cadence is on and the
 * newest feeling-now entry (its clinical effectiveDateTime) predates the
 * current window — i.e. this window has no entry yet. No entry at all ⇒ due.
 * An unparseable timestamp counts as "no entry" rather than silencing the
 * prompt forever.
 */
export function isFeelingDue(
  cadence: FeelingCadence,
  lastEffective: string | undefined,
  now: Date = new Date()
): boolean {
  const win = feelingWindow(cadence, now);
  if (!win) {
    return false;
  }
  if (!lastEffective) {
    return true;
  }
  const t = new Date(lastEffective).getTime();
  return Number.isNaN(t) ? true : t < win.start.getTime();
}

// ---------------------------------------------------------------------------
// Observation builder (pure) + save
// ---------------------------------------------------------------------------

/** One capture from the modal. `mood` is required (a check with no mood is
 * not a check); `energy` only when the user stated one (mapping §4: "one or
 * two quick Observations"). The `*AiParsed` flags implement the provenance
 * policy documented on buildFeelingObservations. */
export interface FeelingInput {
  mood: number; // 1–10
  energy?: number; // 1–10, optional
  /** Typed note or voice transcript — rides in Observation.note. */
  note?: string;
  /** Clinical instant (ISO). Backdating supported: this is effectiveDateTime;
   * record time stays in meta.lastUpdated (CLAUDE.md §6 timestamps). */
  effective: string;
  moodAiParsed?: boolean;
  energyAiParsed?: boolean;
}

/**
 * Build the 1–2 quick Observations for one momentary check. Shapes are
 * byte-compatible with LogPage's mood/energy writes (same CS_OBS codes,
 * survey category, valueInteger, quick-observation identifier) so every
 * existing series/dashboard picks them up unchanged; only meta.tag differs.
 *
 * AI-parsed provenance policy (mapping §4, owner-decided): a value the parser
 * pre-filled AND the user left untouched is written with the `ai-parsed` tag —
 * it is the model's reading of the dictation, confirmed but not authored by
 * the user. The moment the user edits a control, that value becomes their own
 * assertion and the tag drops for THAT value only (per-Observation, since
 * mood and energy are separate resources). Nothing here auto-commits — the
 * user always presses Save (human-in-the-loop gate).
 *
 * The free-text note rides on the mood Observation only: duplicating the same
 * sentence into both resources would double it in every note-reading surface.
 */
export function buildFeelingObservations(patientRef: string, input: FeelingInput): Observation[] {
  const make = (
    code: 'mood' | 'energy',
    value: number,
    aiParsed: boolean,
    withNote: boolean
  ): Observation => ({
    resourceType: 'Observation',
    status: 'final',
    meta: { tag: aiParsed ? [FEELING_TAG, AI_PARSED_TAG] : [FEELING_TAG] },
    category: [{ coding: [{ system: OBS_CATEGORY, code: 'survey' }] }],
    // display string kept identical to LogPage's mood/energy writes
    code: { coding: [{ system: CS_OBS, code, display: `${code} (1-10)` }] },
    subject: { reference: patientRef },
    effectiveDateTime: input.effective,
    valueInteger: value,
    // fresh client event UUID per write — the quick-observation idempotency
    // convention (each save IS a new event; retries reuse the same resource
    // only via the UI's busy guard, matching LogPage behavior)
    identifier: [{ system: QUICK_IDENT, value: crypto.randomUUID() }],
    ...(withNote && input.note ? { note: [{ text: input.note }] } : {}),
  });

  const out: Observation[] = [make('mood', input.mood, input.moodAiParsed === true, true)];
  if (input.energy !== undefined) {
    out.push(make('energy', input.energy, input.energyAiParsed === true, false));
  }
  return out;
}

/** Clinical time of the newest momentary check — ONE server-side filtered
 * search (code + _tag + sort, _count=1 via searchOne), never fetch-all.
 * Feeds the Overview card's due logic. */
export async function loadLastFeeling(medplum: MedplumClient): Promise<string | undefined> {
  const obs = await medplum.searchOne('Observation', {
    code: `${CS_OBS}|mood`,
    _tag: `${TAGS}|feeling-now`,
    _sort: '-date',
  });
  return obs?.effectiveDateTime;
}

/** Save one momentary check: resolve the single Patient, then create the 1–2
 * Observations sequentially (independent quick values — same tradeoff as
 * LogPage's useSaveObservation, whose error notification covers a mid-list
 * failure). Throws when no Patient exists yet. */
export async function saveFeelingCheck(medplum: MedplumClient, input: FeelingInput): Promise<void> {
  const patient = await getPatient(medplum);
  if (!patient) {
    throw new Error('No patient record — run make seed');
  }
  for (const obs of buildFeelingObservations(`Patient/${patient.id}`, input)) {
    await medplum.createResource<Observation>(obs);
  }
}
