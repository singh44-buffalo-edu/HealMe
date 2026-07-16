/**
 * Bot: symptom Observation -> follow-up Task (FHIR-MAPPING.md §2,
 * "Symptom follow-up" row)
 *
 * Event-triggered cadence (spec FR-CAD-3): when a symptom is logged, schedule
 * a check-back for the next day so it does not silently disappear. The Task is
 * display-only workflow — resolving it is always the user's call; nothing
 * clinical is inferred.
 *
 * Where it sits: deployed by scripts/deploy_bots.py with a Subscription on
 * `Observation?code=<local CodeSystem>|symptom` (interaction filter `create`).
 * The frontend's home due-panel surfaces the resulting Tasks.
 *
 * Idempotent per source Observation via identifier
 * `symptom-follow-up-{observationId}` + conditional create (bot subscriptions
 * never retry, and manual re-runs must not duplicate follow-ups).
 */

import { BotEvent, MedplumClient } from '@medplum/core';
import type { Observation, Task } from '@medplum/fhirtypes';

const CS_OBS = 'https://healmedaily.local/fhir/CodeSystem/observation';
const CS_TASK = 'https://healmedaily.local/fhir/CodeSystem/task';
const IDENT_SYSTEM = 'https://healmedaily.local/fhir/identifier/task';

/**
 * Bot entry point.
 *
 * @param medplum - project-scoped client injected by the bot runtime
 * @param event - `event.input` is the Observation that fired the Subscription
 *   (or was handed to $execute on a manual replay)
 * @returns a 1-element array with the follow-up Task (created or found by
 *   identifier), or [] when the input is not a trackable symptom Observation
 *
 * Touches: conditionally creates one Task (status=requested) focused on the
 * symptom Observation, due at onset + 1 day. Nothing else is written.
 */
export async function handler(medplum: MedplumClient, event: BotEvent<Observation>): Promise<Task[]> {
  const observation = event.input;
  if (observation.resourceType !== 'Observation') {
    return [];
  }
  // The Subscription criteria already filter on the symptom code, but a
  // manual $execute replay can pass anything — re-check before acting.
  const isSymptom = observation.code?.coding?.some(
    (c) => c.system === CS_OBS && c.code === 'symptom'
  );
  if (!isSymptom || !observation.id || !observation.subject) {
    return [];
  }

  // Due = clinical onset + 24h ("check back tomorrow"); falls back to the
  // wall clock only when the symptom was logged without an effective time.
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
