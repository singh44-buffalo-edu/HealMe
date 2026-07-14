/**
 * Unit tests for the dose/adherence core — the logic a medical-safety bug
 * would live in. Pure-function level: no Medplum client involved.
 */

import type { MedicationAdministration } from '@medplum/fhirtypes';
import { describe, expect, it } from 'vitest';
import type { MedInfo } from './fhir';
import {
  CS_ADHERENCE,
  IDENT,
  adherenceStats,
  adminForSlot,
  localDateString,
  mondayOf,
  periodIdentValue,
  slotIdentValue,
  slotsForDate,
  summarizeDays,
} from './fhir';

const ADMIN_IDENT = `${IDENT}/medication-administration`;

function med(id: string, slug: string, times: string[], startDate = '2020-01-01'): MedInfo {
  return {
    request: {
      resourceType: 'MedicationRequest',
      id,
      status: 'active',
      intent: 'order',
      subject: { reference: 'Patient/p1' },
      identifier: [{ system: `${IDENT}/medication-request`, value: slug }],
    },
    name: slug,
    instructions: '',
    lifeCritical: false,
    times,
    startDate,
  };
}

function admin(
  slug: string,
  date: string,
  time: string,
  status: 'completed' | 'not-done',
  reason?: 'user-skipped' | 'user-marked-missed'
): MedicationAdministration {
  return {
    resourceType: 'MedicationAdministration',
    status,
    subject: { reference: 'Patient/p1' },
    effectiveDateTime: `${date}T${time}:00Z`,
    identifier: [{ system: ADMIN_IDENT, value: `${slug}-${date}T${time}` }],
    ...(reason
      ? { statusReason: [{ coding: [{ system: CS_ADHERENCE, code: reason }] }] }
      : {}),
  } as MedicationAdministration;
}

const TODAY = new Date('2026-07-13T12:00:00');
const day = (offset: number) => {
  const d = new Date(TODAY);
  d.setDate(d.getDate() + offset);
  return localDateString(d);
};

describe('slot identity', () => {
  it('builds stable identifiers from the request slug + date + HH:MM', () => {
    const m = med('r1', 'med-a', ['09:00:00']);
    expect(slotIdentValue(m, '2026-07-10', '09:00:00')).toBe('med-a-2026-07-10T09:00');
  });

  it('matches an admin to its slot by identifier, not by time proximity', () => {
    const m = med('r1', 'med-a', ['09:00:00']);
    const slots = slotsForDate([m], '2026-07-10');
    const logged = admin('med-a', '2026-07-10', '09:00', 'completed');
    const other = admin('med-a', '2026-07-11', '09:00', 'completed');
    expect(adminForSlot([other, logged], slots[0])?.effectiveDateTime).toContain('2026-07-10');
    expect(adminForSlot([other], slots[0])).toBeUndefined();
  });
});

describe('slotsForDate', () => {
  it('generates one slot per timeOfDay, sorted by time', () => {
    const m = med('r1', 'med-b', ['21:00:00', '09:00:00']);
    const slots = slotsForDate([m], '2026-07-10');
    expect(slots.map((s) => s.time)).toEqual(['09:00:00', '21:00:00']);
  });

  it('does not generate slots before the medication start date', () => {
    const m = med('r1', 'med-new', ['09:00:00'], '2026-07-10');
    expect(slotsForDate([m], '2026-07-09')).toHaveLength(0);
    expect(slotsForDate([m], '2026-07-10')).toHaveLength(1);
  });
});

describe('summarizeDays', () => {
  const m = med('r1', 'med-a', ['09:00:00']);

  it('classifies day statuses', () => {
    const admins = [
      admin('med-a', day(-3), '09:00', 'completed'),
      admin('med-a', day(-2), '09:00', 'not-done', 'user-skipped'),
      // day(-1): unlogged
    ];
    const days = summarizeDays([m], admins, 4, TODAY);
    expect(days.map((d) => d.status)).toEqual(['all-taken', 'none-taken', 'unlogged', 'unlogged']);
  });

  it('marks days with no scheduled meds as no-doses', () => {
    expect(summarizeDays([], [], 2, TODAY).map((d) => d.status)).toEqual(['no-doses', 'no-doses']);
  });

  it('a med added today does not rewrite history', () => {
    const newMed = med('r2', 'med-new', ['09:00:00'], day(0));
    const days = summarizeDays([newMed], [], 3, TODAY);
    expect(days.map((d) => d.status)).toEqual(['no-doses', 'no-doses', 'unlogged']);
  });
});

describe('cadence periods', () => {
  it('mondayOf returns the Monday of the containing week', () => {
    expect(mondayOf(new Date('2026-07-13T12:00:00'))).toBe('2026-07-13'); // a Monday
    expect(mondayOf(new Date('2026-07-15T12:00:00'))).toBe('2026-07-13'); // Wednesday
    expect(mondayOf(new Date('2026-07-19T12:00:00'))).toBe('2026-07-13'); // Sunday -> previous Monday
  });

  it('builds distinct, stable period identifiers per cadence', () => {
    const d = new Date('2026-07-15T12:00:00');
    expect(periodIdentValue('daily-check-in', 'D', d)).toBe('daily-check-in-2026-07-15');
    expect(periodIdentValue('weekly-reflection', 'W', d)).toBe('weekly-reflection-week-2026-07-13');
    expect(periodIdentValue('weekly-reflection', 'M', d)).toBe('weekly-reflection-month-2026-07');
  });
});

describe('adherenceStats', () => {
  const m = med('r1', 'med-a', ['09:00:00']);

  it('counts only slot-matched admins inside the summarized window', () => {
    const admins = [
      admin('med-a', day(-1), '09:00', 'completed'),
      admin('med-a', day(-2), '09:00', 'not-done', 'user-skipped'),
      admin('med-a', day(-40), '09:00', 'completed'), // outside window — ignored
    ];
    const days = summarizeDays([m], admins, 7, TODAY);
    const stats = adherenceStats([m], admins, days);
    expect(stats.taken).toBe(1);
    expect(stats.notDone).toBe(1);
    expect(stats.pct).toBe(50);
    expect(stats.perMed[0].taken).toBe(1);
  });

  it('streak counts consecutive fully-taken days and skips an unfinished today', () => {
    const admins = [
      admin('med-a', day(-1), '09:00', 'completed'),
      admin('med-a', day(-2), '09:00', 'completed'),
      admin('med-a', day(-3), '09:00', 'not-done', 'user-skipped'),
    ];
    const days = summarizeDays([m], admins, 7, TODAY);
    expect(adherenceStats([m], admins, days).streak).toBe(2);
  });

  it('an explicit skip today ends the streak immediately', () => {
    const admins = [
      admin('med-a', day(0), '09:00', 'not-done', 'user-skipped'),
      admin('med-a', day(-1), '09:00', 'completed'),
    ];
    const days = summarizeDays([m], admins, 7, TODAY);
    expect(adherenceStats([m], admins, days).streak).toBe(0);
  });

  it('streak can use a longer window than the stats', () => {
    const admins = Array.from({ length: 40 }, (_, i) =>
      admin('med-a', day(-(i + 1)), '09:00', 'completed')
    );
    const statsDays = summarizeDays([m], admins, 30, TODAY);
    const fullDays = summarizeDays([m], admins, 60, TODAY);
    const stats = adherenceStats([m], admins, statsDays, fullDays);
    expect(stats.streak).toBe(40);
  });
});
