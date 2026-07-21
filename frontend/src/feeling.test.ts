/**
 * Unit tests for the momentary-feeling core (feeling.ts): due-window math,
 * cadence degradation, and the Observation builder's tag/provenance policy.
 * Pure-function level — no Medplum client involved (mirrors fhir.test.ts).
 */

import { describe, expect, it } from 'vitest';
import {
  AI_PARSED_TAG,
  FEELING_TAG,
  QUICK_IDENT,
  buildFeelingObservations,
  feelingWindow,
  isFeelingDue,
  loadFeelingCadence,
} from './feeling';
import { CS_OBS, TAGS } from './fhir';

// A fixed local wall-clock instant: 13:00 local time.
const NOW = new Date('2026-07-21T13:00:00');

describe('feelingWindow', () => {
  it('returns null when the cadence is off', () => {
    expect(feelingWindow('off', NOW)).toBeNull();
  });

  it('splits the local day into equal windows anchored at local midnight', () => {
    // 4×/day → 6h windows; 13:00 falls in [12:00, 18:00)
    const w4 = feelingWindow('4x', NOW);
    expect(w4?.start.getHours()).toBe(12);
    expect(w4?.end.getHours()).toBe(18);
    // 3×/day → 8h windows; 13:00 falls in [08:00, 16:00)
    const w3 = feelingWindow('3x', NOW);
    expect(w3?.start.getHours()).toBe(8);
    expect(w3?.end.getHours()).toBe(16);
    // 2×/day → 12h windows; 13:00 falls in [12:00, 24:00)
    const w2 = feelingWindow('2x', NOW);
    expect(w2?.start.getHours()).toBe(12);
    expect(w2?.end.getDate()).toBe(NOW.getDate() + 1);
  });

  it('pins the very start of the day to the first window', () => {
    const midnight = new Date('2026-07-21T00:00:00');
    const w = feelingWindow('4x', midnight);
    expect(w?.start.getHours()).toBe(0);
    expect(w?.end.getHours()).toBe(6);
  });
});

describe('isFeelingDue', () => {
  it('is never due when the cadence is off', () => {
    expect(isFeelingDue('off', undefined, NOW)).toBe(false);
    expect(isFeelingDue('off', '2020-01-01T00:00:00Z', NOW)).toBe(false);
  });

  it('is due when no entry exists yet', () => {
    expect(isFeelingDue('3x', undefined, NOW)).toBe(true);
  });

  it('is NOT due when the newest entry falls inside the current window', () => {
    // 3× window at 13:00 local is [08:00, 16:00) — an entry at 09:30 covers it
    expect(isFeelingDue('3x', '2026-07-21T09:30:00', NOW)).toBe(false);
  });

  it('is due again when the newest entry predates the current window', () => {
    // 4× window at 13:00 local is [12:00, 18:00) — a 09:30 entry is last window's
    expect(isFeelingDue('4x', '2026-07-21T09:30:00', NOW)).toBe(true);
    // yesterday never covers today
    expect(isFeelingDue('2x', '2026-07-20T23:59:00', NOW)).toBe(true);
  });

  it('treats a future-dated entry as covering (not due)', () => {
    expect(isFeelingDue('3x', '2026-07-21T15:00:00', NOW)).toBe(false);
  });

  it('treats an unparseable timestamp as no entry (due) — never silences the prompt', () => {
    expect(isFeelingDue('3x', 'not-a-date', NOW)).toBe(true);
  });
});

describe('loadFeelingCadence', () => {
  it('degrades to off when storage is unavailable (node test env has none)', () => {
    expect(loadFeelingCadence()).toBe('off');
  });
});

describe('buildFeelingObservations', () => {
  const effective = '2026-07-21T13:05:00.000Z';

  it('writes ONE mood Observation in the exact quick-add shape plus the feeling-now tag', () => {
    const out = buildFeelingObservations('Patient/p1', { mood: 7, effective });
    expect(out).toHaveLength(1);
    const mood = out[0];
    expect(mood.status).toBe('final');
    expect(mood.code?.coding?.[0]).toEqual({ system: CS_OBS, code: 'mood', display: 'mood (1-10)' });
    expect(mood.category?.[0]?.coding?.[0]?.code).toBe('survey');
    expect(mood.valueInteger).toBe(7);
    expect(mood.subject?.reference).toBe('Patient/p1');
    expect(mood.effectiveDateTime).toBe(effective);
    expect(mood.meta?.tag).toEqual([FEELING_TAG]);
    expect(FEELING_TAG.system).toBe(TAGS);
    // fresh client event UUID under the quick-observation system (§7)
    expect(mood.identifier?.[0]?.system).toBe(QUICK_IDENT);
    expect(mood.identifier?.[0]?.value).toMatch(/[0-9a-f-]{36}/);
    expect(mood.note).toBeUndefined();
  });

  it('adds a second energy Observation only when energy was stated', () => {
    const out = buildFeelingObservations('Patient/p1', { mood: 6, energy: 4, effective });
    expect(out).toHaveLength(2);
    expect(out[1].code?.coding?.[0]?.code).toBe('energy');
    expect(out[1].valueInteger).toBe(4);
    expect(out[1].meta?.tag).toEqual([FEELING_TAG]);
    // distinct event UUIDs — two resources, two identities
    expect(out[0].identifier?.[0]?.value).not.toBe(out[1].identifier?.[0]?.value);
  });

  it('rides the note on the mood Observation only (never duplicated)', () => {
    const out = buildFeelingObservations('Patient/p1', {
      mood: 5,
      energy: 5,
      note: 'bit tired after lunch',
      effective,
    });
    expect(out[0].note?.[0]?.text).toBe('bit tired after lunch');
    expect(out[1].note).toBeUndefined();
  });

  it('tags ai-parsed PER VALUE: an untouched parsed value carries it, an edited one does not', () => {
    // mood kept as parsed, energy edited by the user → mood carries ai-parsed,
    // energy is the user's own assertion (provenance policy, mapping §4)
    const out = buildFeelingObservations('Patient/p1', {
      mood: 3,
      energy: 6,
      effective,
      moodAiParsed: true,
      energyAiParsed: false,
    });
    expect(out[0].meta?.tag).toEqual([FEELING_TAG, AI_PARSED_TAG]);
    expect(out[1].meta?.tag).toEqual([FEELING_TAG]);
  });

  it('never emits ai-parsed unless explicitly flagged', () => {
    const out = buildFeelingObservations('Patient/p1', { mood: 8, energy: 8, effective });
    for (const obs of out) {
      expect(obs.meta?.tag?.some((t) => t.code === 'ai-parsed')).toBe(false);
    }
  });
});
