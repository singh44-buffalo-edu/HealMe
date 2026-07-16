/**
 * Tests for the symptom follow-up bot (src/symptom-follow-up.ts) against
 * @medplum/mock's in-memory FHIR repo — no running server needed. Covers:
 * Task shape (focused on the symptom, due onset + 1 day), idempotency per
 * source Observation, and the non-symptom-code guard.
 * Run: `cd backend-bots && npm test` (part of `make check`).
 */
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import type { BotEvent, MedplumClient } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type { Bundle, Observation, SearchParameter } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { beforeAll, describe, expect, it } from 'vitest';
import { handler } from './symptom-follow-up';

const CS_OBS = 'https://healmedaily.local/fhir/CodeSystem/observation';

beforeAll(() => {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
  }
});

function symptomObservation(id: string): Observation {
  return {
    resourceType: 'Observation',
    id,
    status: 'final',
    code: { coding: [{ system: CS_OBS, code: 'symptom' }], text: 'Symptom' },
    subject: { reference: 'Patient/example' },
    effectiveDateTime: '2026-07-13T20:00:00Z',
    valueString: 'mild headache',
  };
}

function makeEvent(input: Observation): BotEvent<Observation> {
  return { bot: { reference: 'Bot/test' }, contentType: 'application/fhir+json', input, secrets: {} };
}

describe('symptom-follow-up', () => {
  it('creates a follow-up Task focused on the symptom, due next day', async () => {
    const medplum = new MockClient();
    const [task] = await handler(medplum as unknown as MedplumClient, makeEvent(symptomObservation('s1')));
    expect(task.status).toBe('requested');
    expect(task.focus?.reference).toBe('Observation/s1');
    expect(task.description).toContain('mild headache');
    expect(task.executionPeriod?.end).toBe('2026-07-14T20:00:00.000Z');
  });

  it('is idempotent per observation', async () => {
    const medplum = new MockClient();
    const [first] = await handler(medplum as unknown as MedplumClient, makeEvent(symptomObservation('s2')));
    const [second] = await handler(medplum as unknown as MedplumClient, makeEvent(symptomObservation('s2')));
    expect(second.id).toBe(first.id);
  });

  it('ignores non-symptom observations', async () => {
    const medplum = new MockClient();
    const obs = symptomObservation('s3');
    obs.code = { coding: [{ system: CS_OBS, code: 'mood' }] };
    expect(await handler(medplum as unknown as MedplumClient, makeEvent(obs))).toHaveLength(0);
  });
});
