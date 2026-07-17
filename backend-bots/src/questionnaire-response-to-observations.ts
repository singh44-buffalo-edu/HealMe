/**
 * Bot: QuestionnaireResponse -> Observations (FHIR-MAPPING.md §4)
 *
 * Fans numeric/scale answers of a completed check-in out to individual
 * Observation resources so dashboards can chart them. The
 * QuestionnaireResponse remains the source of truth for the raw answers.
 *
 * Where it sits: deployed by scripts/deploy_bots.py, which also creates the
 * triggering Subscription (criteria `QuestionnaireResponse`, interaction
 * filters `create` AND `update` — the frontend edits a period's response in
 * place, and amendments must re-derive). Runs inside Medplum's vmcontext
 * runtime; its only dependency is the FHIR API via the injected
 * MedplumClient. The frontend check-in pages write the
 * QuestionnaireResponses that fire it.
 *
 * ⚠️ Bot-endpoint subscriptions execute ONCE and never retry (CLAUDE.md §5),
 * hence the two design rules of this bot:
 *  - Idempotent UPSERT: each Observation carries a stable identifier
 *    (responseId-linkId, FHIR-MAPPING.md §7); the bot searches by it and
 *    creates when absent, updates in place when the answer changed, and
 *    leaves it untouched when identical — so re-runs / re-fired
 *    subscriptions never duplicate, and amended check-ins converge on the
 *    latest answers instead of charting the first submission forever.
 *  - Recoverable: a missed run can be replayed over history at any time
 *    (POST the QuestionnaireResponse to Bot/$execute) with the same outcome.
 *
 * Deliberately NOT handled: an answer that vanishes from an amended response
 * does not delete its previously derived Observation. The check-in UI always
 * submits the complete fixed form (values change; linkIds don't disappear),
 * and auto-deleting derived clinical data on an absent answer would be a
 * destructive inference — the QuestionnaireResponse stays the source of
 * truth, and a genuinely retired datapoint can be removed via the Medplum
 * App.
 *
 * This IS the "Bot strategy" of FHIR-MAPPING.md §4 — do not also enable SDC
 * template extraction for the same forms, or answers would fan out twice.
 */

import { BotEvent, MedplumClient, getQuestionnaireAnswers } from '@medplum/core';
import type {
  Coding,
  Observation,
  Questionnaire,
  QuestionnaireItem,
  QuestionnaireResponse,
} from '@medplum/fhirtypes';

// Identifier system for bot-derived Observations; the stable value is
// `{responseId}-{linkId}` ("Derived Observation" row, FHIR-MAPPING.md §7).
const IDENT_SYSTEM = 'https://healmedaily.local/fhir/identifier/questionnaire-observation';
const UCUM = 'http://unitsofmeasure.org';

// Decimal answers whose Observation should carry a UCUM-coded quantity.
// Codes not listed here get a bare valueQuantity (number only); integer
// scale answers (mood/energy/stress/rested) stay valueInteger regardless.
const UNITS_BY_CODE: Record<string, { unit: string; code: string }> = {
  'sleep-duration': { unit: 'h', code: 'h' },
};

/**
 * Bot entry point.
 *
 * @param medplum - project-scoped client injected by the bot runtime
 * @param event - `event.input` is the QuestionnaireResponse that fired the
 *   Subscription (or was passed to $execute on a manual replay)
 * @returns the Observations that now exist for this response (freshly
 *   created, updated to the amended answer, or found unchanged by
 *   identifier); empty when the response is unusable (missing
 *   id/subject/questionnaire) or its Questionnaire cannot be resolved
 *
 * Touches: reads Questionnaire (by canonical url), upserts Observations
 * (conditional create / update-on-change). Never modifies the
 * QuestionnaireResponse itself.
 */
export async function handler(
  medplum: MedplumClient,
  event: BotEvent<QuestionnaireResponse>
): Promise<Observation[]> {
  const response = event.input;
  if (response.resourceType !== 'QuestionnaireResponse') {
    throw new Error(`expected QuestionnaireResponse, got ${response.resourceType}`);
  }
  // Only fan out COMPLETED responses. The subscription fires on create+update,
  // and an in-progress draft (status 'in-progress'/'stopped') must not chart
  // partial answers as final Observations — it would derive values the owner
  // has not committed, then leave them stale when the draft is finished.
  if (response.status !== 'completed') {
    return [];
  }
  if (!response.id || !response.subject || !response.questionnaire) {
    return [];
  }

  // The response may reference 'url|version' — resolve the item definitions
  // (and their Observation codes) from the canonical url.
  const canonicalUrl = response.questionnaire.split('|')[0];
  // status=active resolves uniquely — superseded versions are retired by seed
  const questionnaire =
    (await medplum.searchOne('Questionnaire', { url: canonicalUrl, status: 'active' })) ??
    (await medplum.searchOne('Questionnaire', { url: canonicalUrl }));
  if (!questionnaire) {
    return [];
  }

  const answers = getQuestionnaireAnswers(response);
  const created: Observation[] = [];

  // Only questionnaire items that carry a code fan out — the item's code[0]
  // becomes the Observation code (local CodeSystem or verified LOINC; never
  // invented, per CLAUDE.md §3). Free-text items stay in the response only.
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

    // Dedup key: same response + same item can only ever yield one
    // Observation, no matter how many times this bot runs.
    const identifierValue = `${response.id}-${item.linkId}`;
    const desired: Observation = {
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
    };

    // Upsert: an amended check-in (same response id, new answers) must
    // update the derived Observation in place, not be skipped as a
    // duplicate. Identical replays stay writeless so a re-fired
    // subscription or manual $execute never churns versions.
    const existing = await medplum.searchOne('Observation', {
      identifier: `${IDENT_SYSTEM}|${identifierValue}`,
    });
    let observation: Observation;
    if (!existing) {
      // Conditional create (not plain create): two concurrent first runs
      // still converge on one resource.
      observation = await medplum.createResourceIfNoneExist<Observation>(
        desired,
        `identifier=${IDENT_SYSTEM}|${identifierValue}`
      );
    } else if (sameDerivedContent(existing, desired)) {
      observation = existing;
    } else {
      observation = await medplum.updateResource<Observation>({ ...desired, id: existing.id });
    }
    created.push(observation);
  }

  return created;
}

/** True when the fields an amendment can change (value + clinical time) are
 * identical — the replay/no-churn guard of the upsert. */
function sameDerivedContent(existing: Observation, desired: Observation): boolean {
  const pick = (o: Observation) =>
    JSON.stringify([o.valueInteger ?? null, o.valueQuantity ?? null, o.effectiveDateTime ?? null]);
  return pick(existing) === pick(desired);
}

/** Depth-first flatten of nested questionnaire item groups. */
function flattenItems(items: QuestionnaireItem[]): QuestionnaireItem[] {
  return items.flatMap((item) => [item, ...flattenItems(item.item ?? [])]);
}

export type { Questionnaire };
