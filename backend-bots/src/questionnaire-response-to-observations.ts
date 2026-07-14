/**
 * Bot: QuestionnaireResponse -> Observations
 *
 * Fans numeric/scale answers of a completed check-in out to individual
 * Observation resources so dashboards can chart them. The
 * QuestionnaireResponse remains the source of truth for the raw answers.
 *
 * Idempotent: each Observation carries a stable identifier
 * (responseId-linkId) and is created with a conditional create, so re-runs
 * (or re-fired subscriptions) never duplicate. Bot subscriptions never retry
 * on failure, so this bot is safe to re-run over history at any time.
 */

import { BotEvent, MedplumClient, getQuestionnaireAnswers } from '@medplum/core';
import type {
  Coding,
  Observation,
  Questionnaire,
  QuestionnaireItem,
  QuestionnaireResponse,
} from '@medplum/fhirtypes';

const IDENT_SYSTEM = 'https://healmedaily.local/fhir/identifier/questionnaire-observation';
const UCUM = 'http://unitsofmeasure.org';

const UNITS_BY_CODE: Record<string, { unit: string; code: string }> = {
  'sleep-duration': { unit: 'h', code: 'h' },
};

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<QuestionnaireResponse>
): Promise<Observation[]> {
  const response = event.input;
  if (response.resourceType !== 'QuestionnaireResponse') {
    throw new Error(`expected QuestionnaireResponse, got ${response.resourceType}`);
  }
  if (!response.id || !response.subject || !response.questionnaire) {
    return [];
  }

  const canonicalUrl = response.questionnaire.split('|')[0];
  const questionnaire = await medplum.searchOne('Questionnaire', { url: canonicalUrl });
  if (!questionnaire) {
    return [];
  }

  const answers = getQuestionnaireAnswers(response);
  const created: Observation[] = [];

  for (const item of flattenItems(questionnaire.item ?? [])) {
    const code = item.code?.[0];
    if (!code?.code || !item.linkId) {
      continue;
    }
    const answer = answers[item.linkId];
    if (!answer) {
      continue;
    }

    let valueFields: Pick<Observation, 'valueInteger' | 'valueQuantity'> | undefined;
    if (typeof answer.valueInteger === 'number') {
      valueFields = { valueInteger: answer.valueInteger };
    } else if (typeof answer.valueDecimal === 'number') {
      const unit = UNITS_BY_CODE[code.code];
      valueFields = {
        valueQuantity: unit
          ? { value: answer.valueDecimal, unit: unit.unit, system: UCUM, code: unit.code }
          : { value: answer.valueDecimal },
      };
    } else {
      continue; // only numeric/scale answers become Observations
    }

    const identifierValue = `${response.id}-${item.linkId}`;
    const observation = await medplum.createResourceIfNoneExist<Observation>(
      {
        resourceType: 'Observation',
        status: 'final',
        category: [
          {
            coding: [
              { system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'survey' },
            ],
          },
        ],
        code: { coding: [code as Coding], text: item.text },
        subject: response.subject as Observation['subject'],
        effectiveDateTime: response.authored,
        derivedFrom: [{ reference: `QuestionnaireResponse/${response.id}` }],
        identifier: [{ system: IDENT_SYSTEM, value: identifierValue }],
        ...valueFields,
      },
      `identifier=${IDENT_SYSTEM}|${identifierValue}`
    );
    created.push(observation);
  }

  return created;
}

function flattenItems(items: QuestionnaireItem[]): QuestionnaireItem[] {
  return items.flatMap((item) => [item, ...flattenItems(item.item ?? [])]);
}

export type { Questionnaire };
