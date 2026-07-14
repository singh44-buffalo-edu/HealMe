/**
 * Bot: symptom Observation -> follow-up Task
 *
 * Event-triggered cadence (spec FR-CAD-3): when a symptom is logged, schedule
 * a check-back for the next day so it does not silently disappear. The Task is
 * display-only workflow — resolving it is always the user's call; nothing
 * clinical is inferred.
 *
 * Idempotent per source Observation (bot subscriptions never retry, and
 * re-runs must not duplicate follow-ups).
 */

import { BotEvent, MedplumClient } from '@medplum/core';
import type { Observation, Task } from '@medplum/fhirtypes';

const CS_OBS = 'https://healmedaily.local/fhir/CodeSystem/observation';
const CS_TASK = 'https://healmedaily.local/fhir/CodeSystem/task';
const IDENT_SYSTEM = 'https://healmedaily.local/fhir/identifier/task';

export async function handler(medplum: MedplumClient, event: BotEvent<Observation>): Promise<Task[]> {
  const observation = event.input;
  if (observation.resourceType !== 'Observation') {
    return [];
  }
  const isSymptom = observation.code?.coding?.some(
    (c) => c.system === CS_OBS && c.code === 'symptom'
  );
  if (!isSymptom || !observation.id || !observation.subject) {
    return [];
  }

  const onset = observation.effectiveDateTime ?? new Date().toISOString();
  const followUpDue = new Date(new Date(onset).getTime() + 24 * 3600 * 1000).toISOString();
  const identifierValue = `symptom-follow-up-${observation.id}`;

  const task = await medplum.createResourceIfNoneExist<Task>(
    {
      resourceType: 'Task',
      status: 'requested',
      intent: 'plan',
      code: {
        coding: [{ system: CS_TASK, code: 'symptom-follow-up', display: 'Symptom follow-up' }],
        text: 'Symptom follow-up',
      },
      description: `Check back: ${observation.valueString ?? 'symptom'}`,
      for: observation.subject,
      focus: { reference: `Observation/${observation.id}` },
      authoredOn: onset,
      executionPeriod: { end: followUpDue },
      identifier: [{ system: IDENT_SYSTEM, value: identifierValue }],
    },
    `identifier=${IDENT_SYSTEM}|${identifierValue}`
  );
  return [task];
}
