/**
 * Tests for the dose-reminders cron bot (src/reminders-runner.ts) against
 * @medplum/mock's in-memory FHIR repo, with the clock frozen via the bot's
 * Parameters{now} test hook and the timezone pinned via the app-config Basic
 * (exactly what scripts/seed.py creates), so nothing depends on the machine
 * running the tests. Covers: reminder only after slot + 90min grace, neutral
 * "not logged" wording (never "missed"), idempotent identifiers, suppression
 * when the slot already has ANY MedicationAdministration (taken or skipped),
 * the medical-safety invariant that the bot never writes dose status, the
 * authoredOn start anchor, and the timezone contract — slot identity derives
 * from the OWNER's configured zone (IST fixture), with a UTC fallback when
 * the app-config Basic is absent.
 * Run: `cd backend-bots && npm test` (part of `make check`).
 */
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import type { BotEvent, MedplumClient } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type {
  Bundle,
  MedicationRequest,
  Parameters,
  Resource,
  SearchParameter,
} from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { beforeAll, describe, expect, it } from 'vitest';
import { handler, zonedDateString, zonedInstant } from './reminders-runner';

const IDENT = 'https://healmedaily.local/fhir/identifier';
const ADMIN_IDENT = `${IDENT}/medication-administration`;
const REMINDER_IDENT = `${IDENT}/communication-request`;
const APP_CONFIG_IDENT = `${IDENT}/app-config`;
const EXT_TIME_ZONE = 'https://healmedaily.local/fhir/StructureDefinition/app-config-time-zone';

beforeAll(() => {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
  }
});

// Deterministic clock, explicit UTC instant: with the UTC app-config the
// 08:00 slot is past due + grace, the 20:00 slot is not.
const NOW = '2026-07-15T12:00:00Z';
const TODAY = '2026-07-15';

function nowParams(value: string = NOW): Parameters {
  return { resourceType: 'Parameters', parameter: [{ name: 'now', valueDateTime: value }] };
}

function makeEvent(input: Resource): BotEvent<Resource> {
  return { bot: { reference: 'Bot/test' }, contentType: 'application/fhir+json', input, secrets: {} };
}

/** The app-config Basic exactly as scripts/seed.py creates it. */
async function makeAppConfig(medplum: MockClient, timeZone: string): Promise<void> {
  await medplum.createResource({
    resourceType: 'Basic',
    identifier: [{ system: APP_CONFIG_IDENT, value: 'app-config' }],
    code: {
      coding: [
        {
          system: 'https://healmedaily.local/fhir/CodeSystem/app-config',
          code: 'app-config',
        },
      ],
    },
    extension: [{ url: EXT_TIME_ZONE, valueString: timeZone }],
  });
}

async function makeRequest(medplum: MockClient, slug = 'test-med'): Promise<MedicationRequest> {
  return medplum.createResource<MedicationRequest>({
    resourceType: 'MedicationRequest',
    status: 'active',
    intent: 'order',
    subject: { reference: 'Patient/123' },
    medicationReference: { reference: 'Medication/m1', display: 'Lisinopril 10mg' },
    authoredOn: '2026-07-01',
    identifier: [{ system: `${IDENT}/medication-request`, value: slug }],
    dosageInstruction: [
      { timing: { repeat: { timeOfDay: ['08:00:00', '20:00:00'] } } },
    ],
  });
}

describe('reminders-runner', () => {
  it('creates one reminder per slot past due + grace, none for future slots', async () => {
    const medplum = new MockClient();
    await makeAppConfig(medplum, 'UTC');
    await makeRequest(medplum);

    const created = await handler(medplum as unknown as MedplumClient, makeEvent(nowParams()));
    expect(created).toHaveLength(1);

    const reminder = created[0];
    expect(reminder.status).toBe('active');
    expect(reminder.identifier?.[0]).toEqual({
      system: REMINDER_IDENT,
      value: `reminder/test-med/${TODAY}T08:00`,
    });
    expect(reminder.medium?.[0]?.coding?.[0]?.code).toBe('push');
    expect(reminder.payload?.[0]?.contentString).toContain('Lisinopril 10mg');
    expect(reminder.payload?.[0]?.contentString).toContain('not been logged');
    expect(reminder.payload?.[0]?.contentString).not.toContain('missed');
    expect(reminder.about?.[0]?.reference).toMatch(/^MedicationRequest\//);
  });

  it('reminds a late-evening slot after it crosses midnight (previous-day scan)', async () => {
    const medplum = new MockClient();
    await makeAppConfig(medplum, 'UTC');
    // A single 23:30 slot on 2026-07-15 — due (grace 90m) at 01:00 on 07-16.
    await medplum.createResource<MedicationRequest>({
      resourceType: 'MedicationRequest',
      status: 'active',
      intent: 'order',
      subject: { reference: 'Patient/123' },
      medicationReference: { reference: 'Medication/m1', display: 'Lisinopril 10mg' },
      authoredOn: '2026-07-01',
      identifier: [{ system: `${IDENT}/medication-request`, value: 'test-med' }],
      dosageInstruction: [{ timing: { repeat: { timeOfDay: ['23:30:00'] } } }],
    });
    // 01:05 on 07-16: the 07-15 slot became overdue 5 min ago. Before the
    // previous-day scan, "today" was 07-16 and this slot was never examined.
    const created = await handler(
      medplum as unknown as MedplumClient,
      makeEvent(nowParams('2026-07-16T01:05:00Z'))
    );
    expect(created).toHaveLength(1);
    expect(created[0].identifier?.[0]?.value).toBe('reminder/test-med/2026-07-15T23:30');
  });

  it('does not remind a stale slot that became overdue on a prior day', async () => {
    const medplum = new MockClient();
    await makeAppConfig(medplum, 'UTC');
    await medplum.createResource<MedicationRequest>({
      resourceType: 'MedicationRequest',
      status: 'active',
      intent: 'order',
      subject: { reference: 'Patient/123' },
      medicationReference: { reference: 'Medication/m1', display: 'Lisinopril 10mg' },
      authoredOn: '2026-07-01',
      identifier: [{ system: `${IDENT}/medication-request`, value: 'test-med' }],
      dosageInstruction: [{ timing: { repeat: { timeOfDay: ['08:00:00'] } } }],
    });
    // Yesterday's 08:00 dose was overdue yesterday; it must not resurface as a
    // day-late reminder now (only slots overdue since today's midnight qualify).
    const created = await handler(
      medplum as unknown as MedplumClient,
      makeEvent(nowParams('2026-07-16T12:00:00Z'))
    );
    expect(created.map((r) => r.identifier?.[0]?.value)).toEqual(['reminder/test-med/2026-07-16T08:00']);
  });

  it('slot inside the 90min grace window gets no reminder yet', async () => {
    const medplum = new MockClient();
    await makeAppConfig(medplum, 'UTC');
    await makeRequest(medplum);
    // 09:00Z is only 60 min after the 08:00 UTC slot — inside grace
    const created = await handler(
      medplum as unknown as MedplumClient,
      makeEvent(nowParams('2026-07-15T09:00:00Z'))
    );
    expect(created).toHaveLength(0);
  });

  it('is idempotent across runs (stable reminder identifier)', async () => {
    const medplum = new MockClient();
    await makeAppConfig(medplum, 'UTC');
    await makeRequest(medplum);

    const [first] = await handler(medplum as unknown as MedplumClient, makeEvent(nowParams()));
    const [second] = await handler(medplum as unknown as MedplumClient, makeEvent(nowParams()));
    expect(second.id).toBe(first.id);

    const all = await medplum.searchResources('CommunicationRequest');
    expect(all).toHaveLength(1);
  });

  it('skips slots that already have a logged dose (taken OR skipped)', async () => {
    const medplum = new MockClient();
    await makeAppConfig(medplum, 'UTC');
    await makeRequest(medplum);
    // Same slot identifier the frontend writes on log
    await medplum.createResource({
      resourceType: 'MedicationAdministration',
      status: 'completed',
      subject: { reference: 'Patient/123' },
      medicationReference: { reference: 'Medication/m1' },
      effectiveDateTime: `${TODAY}T08:05:00Z`,
      identifier: [{ system: ADMIN_IDENT, value: `test-med-${TODAY}T08:00` }],
    });

    const created = await handler(medplum as unknown as MedplumClient, makeEvent(nowParams()));
    expect(created).toHaveLength(0);
  });

  it('never writes dose status — no MedicationAdministration is ever created', async () => {
    const medplum = new MockClient();
    await makeAppConfig(medplum, 'UTC');
    await makeRequest(medplum);
    await handler(medplum as unknown as MedplumClient, makeEvent(nowParams()));
    const admins = await medplum.searchResources('MedicationAdministration');
    expect(admins).toHaveLength(0);
  });

  it('ignores requests that have not started yet (authoredOn in the future)', async () => {
    const medplum = new MockClient();
    await makeAppConfig(medplum, 'UTC');
    const req = await makeRequest(medplum);
    await medplum.updateResource({ ...req, authoredOn: '2026-08-01' });
    const created = await handler(medplum as unknown as MedplumClient, makeEvent(nowParams()));
    expect(created).toHaveLength(0);
  });

  it('derives slot identity in the configured owner zone, not the process/UTC clock (IST)', async () => {
    const medplum = new MockClient();
    await makeAppConfig(medplum, 'Asia/Kolkata');
    await makeRequest(medplum);

    // 05:00Z = 10:30 IST: the 08:00 IST slot (02:30Z) is 2.5h past — due.
    // A UTC-clocked bot would see the 08:00 UTC slot as 3h in the FUTURE
    // and stay silent; this is the exact divergence the app-config fixes.
    const created = await handler(
      medplum as unknown as MedplumClient,
      makeEvent(nowParams('2026-07-15T05:00:00Z'))
    );
    expect(created).toHaveLength(1);
    // Identifier carries the IST wall-clock slot — same value the UI writes.
    expect(created[0].identifier?.[0]?.value).toBe('reminder/test-med/2026-07-15T08:00');
    // The stored instant is that IST wall-clock as an absolute time.
    expect(new Date(created[0].occurrenceDateTime as string).toISOString()).toBe(
      '2026-07-15T02:30:00.000Z'
    );
  });

  it("derives 'today' in the owner zone across the UTC date boundary (IST)", async () => {
    const medplum = new MockClient();
    await makeAppConfig(medplum, 'Asia/Kolkata');
    await makeRequest(medplum);

    // 2026-07-14T20:30Z = 2026-07-15 02:00 IST: IST's "today" is the 15th
    // and neither of its slots is due yet — no reminders. A UTC-date bot
    // would still be on the 14th and fire for that day's 08:00 slot.
    const created = await handler(
      medplum as unknown as MedplumClient,
      makeEvent(nowParams('2026-07-14T20:30:00Z'))
    );
    expect(created).toHaveLength(0);
  });

  it('falls back to UTC slot identity when the app-config Basic is absent', async () => {
    const medplum = new MockClient();
    await makeRequest(medplum); // no app-config seeded
    const created = await handler(medplum as unknown as MedplumClient, makeEvent(nowParams()));
    expect(created).toHaveLength(1);
    expect(created[0].identifier?.[0]?.value).toBe(`reminder/test-med/${TODAY}T08:00`);
  });

  it('falls back to UTC when the configured zone is not a valid IANA name', async () => {
    const medplum = new MockClient();
    await makeAppConfig(medplum, 'Not/AZone');
    await makeRequest(medplum);
    const created = await handler(medplum as unknown as MedplumClient, makeEvent(nowParams()));
    expect(created).toHaveLength(1);
    expect(created[0].identifier?.[0]?.value).toBe(`reminder/test-med/${TODAY}T08:00`);
  });
});

describe('zoned time helpers', () => {
  it('zonedDateString formats the calendar date of an instant in a zone', () => {
    const instant = new Date('2026-07-14T20:30:00Z');
    expect(zonedDateString(instant, 'Asia/Kolkata')).toBe('2026-07-15');
    expect(zonedDateString(instant, 'UTC')).toBe('2026-07-14');
  });

  it('zonedInstant resolves a wall-clock slot to the correct absolute instant', () => {
    expect(zonedInstant('2026-07-15', '08:00:00', 'Asia/Kolkata').toISOString()).toBe(
      '2026-07-15T02:30:00.000Z'
    );
    expect(zonedInstant('2026-07-15', '08:00:00', 'UTC').toISOString()).toBe(
      '2026-07-15T08:00:00.000Z'
    );
    // DST-observing zone, summer offset (America/Los_Angeles = UTC-7 in July)
    expect(zonedInstant('2026-07-15', '08:00:00', 'America/Los_Angeles').toISOString()).toBe(
      '2026-07-15T15:00:00.000Z'
    );
    expect(Number.isNaN(zonedInstant('2026-07-15', 'nonsense', 'UTC').getTime())).toBe(true);
  });
});
