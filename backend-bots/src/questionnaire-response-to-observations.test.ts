/**
 * Tests for the QuestionnaireResponse -> Observations bot
 * (src/questionnaire-response-to-observations.ts) against @medplum/mock's
 * in-memory FHIR repo — no running server needed. Covers: one Observation
 * per numeric answer (strings skipped), UCUM-coded sleep hours, derivedFrom +
 * effectiveDateTime propagation, idempotent re-runs via the stable
 * responseId-linkId identifier, and the missing-questionnaire guard.
 * Run: `cd backend-bots && npm test` (part of `make check`).
 */
import { MockClient } from '@medplum/mock';
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import type { BotEvent, MedplumClient } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type { Bundle, Questionnaire, QuestionnaireResponse, SearchParameter } from '@medplum/fhirtypes';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handler } from './questionnaire-response-to-observations';

beforeAll(() => {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
  }
});

const OBS_SYSTEM = 'https://healmedaily.local/fhir/CodeSystem/observation';
const Q_URL = 'https://healmedaily.local/fhir/Questionnaire/daily-check-in';

const questionnaire: Questionnaire = {
  resourceType: 'Questionnaire',
  url: Q_URL,
  version: '1.0.0',
  name: 'DailyCheckIn',
  title: 'Daily check-in',
  status: 'active',
  item: [
    { linkId: 'mood', text: 'Mood (1-10)', type: 'integer', code: [{ system: OBS_SYSTEM, code: 'mood' }] },
    { linkId: 'energy', text: 'Energy (1-10)', type: 'integer', code: [{ system: OBS_SYSTEM, code: 'energy' }] },
    {
      linkId: 'sleep-hours',
      text: 'Hours slept',
      type: 'decimal',
      code: [{ system: OBS_SYSTEM, code: 'sleep-duration' }],
    },
    { linkId: 'notes', text: 'Notes', type: 'string' },
  ],
};

function makeResponse(id: string): QuestionnaireResponse {
  return {
    resourceType: 'QuestionnaireResponse',
    id,
    status: 'completed',
    questionnaire: Q_URL,
    subject: { reference: 'Patient/example' },
    authored: '2026-07-13T21:30:00-07:00',
    item: [
      { linkId: 'mood', answer: [{ valueInteger: 7 }] },
      { linkId: 'energy', answer: [{ valueInteger: 5 }] },
      { linkId: 'sleep-hours', answer: [{ valueDecimal: 7.5 }] },
      { linkId: 'notes', answer: [{ valueString: 'slept well' }] },
    ],
  };
}

function makeEvent(input: QuestionnaireResponse): BotEvent<QuestionnaireResponse> {
  return { bot: { reference: 'Bot/test' }, contentType: 'application/fhir+json', input, secrets: {} };
}

describe('questionnaire-response-to-observations', () => {
  let medplum: MockClient;

  beforeEach(async () => {
    medplum = new MockClient();
    await medplum.createResource(questionnaire);
  });

  it('creates one Observation per numeric answer, skipping strings', async () => {
    const created = await handler(medplum as unknown as MedplumClient, makeEvent(makeResponse('qr-1')));
    expect(created).toHaveLength(3);

    const codes = created.map((o) => o.code?.coding?.[0]?.code).sort();
    expect(codes).toEqual(['energy', 'mood', 'sleep-duration']);

    const mood = created.find((o) => o.code?.coding?.[0]?.code === 'mood');
    expect(mood?.valueInteger).toBe(7);
    expect(mood?.derivedFrom?.[0]?.reference).toBe('QuestionnaireResponse/qr-1');
    expect(mood?.effectiveDateTime).toBe('2026-07-13T21:30:00-07:00');

    const sleep = created.find((o) => o.code?.coding?.[0]?.code === 'sleep-duration');
    expect(sleep?.valueQuantity?.value).toBe(7.5);
    expect(sleep?.valueQuantity?.code).toBe('h');
  });

  it('is idempotent across re-runs of the same response', async () => {
    const first = await handler(medplum as unknown as MedplumClient, makeEvent(makeResponse('qr-2')));
    const second = await handler(medplum as unknown as MedplumClient, makeEvent(makeResponse('qr-2')));
    expect(second.map((o) => o.id).sort()).toEqual(first.map((o) => o.id).sort());
    const observations = await medplum.searchResources(
      'Observation',
      'identifier=https://healmedaily.local/fhir/identifier/questionnaire-observation|qr-2-mood'
    );
    expect(observations).toHaveLength(1);
  });

  it('returns empty for a response without a questionnaire reference', async () => {
    const response = { ...makeResponse('qr-3'), questionnaire: undefined };
    const created = await handler(medplum as unknown as MedplumClient, makeEvent(response));
    expect(created).toHaveLength(0);
  });
});
