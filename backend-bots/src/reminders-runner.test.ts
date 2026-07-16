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
import { handler } from './reminders-runner';

const IDENT = 'https://healmedaily.local/fhir/identifier';
const ADMIN_IDENT = `${IDENT}/medication-administration`;
const REMINDER_IDENT = `${IDENT}/communication-request`;

beforeAll(() => {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
  }
});

// Deterministic clock: local noon — the 08:00 slot is past due + grace,
// the 20:00 slot is not.
const NOW = '2026-07-15T12:00:00';
const TODAY = '2026-07-15';

function nowParams(value: string = NOW): Parameters {
  return { resourceType: 'Parameters', parameter: [{ name: 'now', valueDateTime: value }] };
}

function makeEvent(input: Resource): BotEvent<Resource> {
  return { bot: { reference: 'Bot/test' }, contentType: 'application/fhir+json', input, secrets: {} };
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

  it('slot inside the 90min grace window gets no reminder yet', async () => {
    const medplum = new MockClient();
    await makeRequest(medplum);
    // 09:00 is only 60 min after the 08:00 slot — inside grace
    const created = await handler(
      medplum as unknown as MedplumClient,
      makeEvent(nowParams('2026-07-15T09:00:00'))
    );
    expect(created).toHaveLength(0);
  });

  it('is idempotent across runs (stable reminder identifier)', async () => {
    const medplum = new MockClient();
    await makeRequest(medplum);

    const [first] = await handler(medplum as unknown as MedplumClient, makeEvent(nowParams()));
    const [second] = await handler(medplum as unknown as MedplumClient, makeEvent(nowParams()));
    expect(second.id).toBe(first.id);

    const all = await medplum.searchResources('CommunicationRequest');
    expect(all).toHaveLength(1);
  });

  it('skips slots that already have a logged dose (taken OR skipped)', async () => {
    const medplum = new MockClient();
    await makeRequest(medplum);
    // Same slot identifier the frontend writes on log
    await medplum.createResource({
      resourceType: 'MedicationAdministration',
      status: 'completed',
      subject: { reference: 'Patient/123' },
      medicationReference: { reference: 'Medication/m1' },
      effectiveDateTime: `${TODAY}T08:05:00`,
      identifier: [{ system: ADMIN_IDENT, value: `test-med-${TODAY}T08:00` }],
    });

    const created = await handler(medplum as unknown as MedplumClient, makeEvent(nowParams()));
    expect(created).toHaveLength(0);
  });

  it('never writes dose status — no MedicationAdministration is ever created', async () => {
    const medplum = new MockClient();
    await makeRequest(medplum);
    await handler(medplum as unknown as MedplumClient, makeEvent(nowParams()));
    const admins = await medplum.searchResources('MedicationAdministration');
    expect(admins).toHaveLength(0);
  });

  it('ignores requests that have not started yet (authoredOn in the future)', async () => {
    const medplum = new MockClient();
    const req = await makeRequest(medplum);
    await medplum.updateResource({ ...req, authoredOn: '2026-08-01' });
    const created = await handler(medplum as unknown as MedplumClient, makeEvent(nowParams()));
    expect(created).toHaveLength(0);
  });
});
