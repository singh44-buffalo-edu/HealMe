/**
 * Bot: dose reminders runner (cron, every 15 min — no Subscription)
 *
 * Scans active MedicationRequests, computes today's scheduled dose slots from
 * timing.repeat.timeOfDay (seconds required, e.g. '09:00:00'), and for every
 * slot past due + 90 min grace with NO logged MedicationAdministration it
 * creates one CommunicationRequest reminder (status=active, medium local code
 * push). Idempotent: identifier reminder/{request-slug}/{occurrence}.
 *
 * Medical-safety rule (FHIR-MAPPING.md §3/§12): this bot is display/notify
 * ONLY. It never writes dose status — absence of a log is never persisted as
 * a "missed" dose from elapsed time alone.
 *
 * Slot identity matches the frontend exactly (frontend/src/fhir.ts
 * slotIdentValue): `{request-slug}-{YYYY-MM-DD}T{HH:MM}` under the
 * medication-administration identifier system, so a dose logged in the UI is
 * always seen here.
 *
 * Where it sits: deployed by scripts/deploy_bots.py, which sets
 * Bot.cronString (every 15 minutes) — Medplum's scheduler invokes it
 * directly (requires the 'cron' project feature; deploy_bots.py enables it
 * as super admin). Because every run rescans from scratch and all writes are
 * conditional creates on stable identifiers, a missed cron tick is harmless:
 * the next tick produces the identical result.
 */

import { BotEvent, MedplumClient } from '@medplum/core';
import type {
  CommunicationRequest,
  MedicationRequest,
  Parameters,
  Resource,
} from '@medplum/fhirtypes';

const BASE = 'https://healmedaily.local/fhir';
const IDENT = `${BASE}/identifier`;
const ADMIN_IDENT_SYSTEM = `${IDENT}/medication-administration`;
const REQUEST_IDENT_SYSTEM = `${IDENT}/medication-request`;
const REMINDER_IDENT_SYSTEM = `${IDENT}/communication-request`;
const CS_MEDIUM = `${BASE}/CodeSystem/communication-medium`;

/**
 * Grace period after the scheduled slot before a reminder fires. 90 min keeps
 * ordinary lateness (breakfast at 9:30 for a 9:00 dose) from nagging while
 * still catching a genuinely forgotten dose the same morning. Exported so the
 * tests pin the boundary.
 */
export const GRACE_MINUTES = 90;

/**
 * Cron entry point — one full scan per invocation.
 *
 * @param medplum - project-scoped client injected by the bot runtime
 * @param event - cron invocations carry no meaningful input; tests pass a
 *   Parameters resource with a 'now' valueDateTime to freeze the clock
 * @returns the CommunicationRequests that now exist for this run — one per
 *   overdue-and-unlogged slot (created or found by identifier); empty when
 *   nothing is due
 *
 * Touches: reads MedicationRequest + MedicationAdministration, conditionally
 * creates CommunicationRequest. NEVER writes MedicationAdministration — see
 * the medical-safety rule in the file header. Idempotent at any frequency.
 */
export async function handler(
  medplum: MedplumClient,
  event: BotEvent<Parameters | Resource | undefined>
): Promise<CommunicationRequest[]> {
  const now = resolveNow(event.input);
  const today = localDateString(now);
  const created: CommunicationRequest[] = [];

  // Single-user regimen: a handful of active meds, so _count=100 covers the
  // whole set without pagination (Medplum default _count is only 20).
  const requests = await medplum.searchResources('MedicationRequest', {
    status: 'active',
    _count: '100',
  });

  for (const request of requests) {
    if (!request.id || !request.subject) {
      continue;
    }
    // authoredOn is the medication start anchor (FHIR-MAPPING.md §2) —
    // slots only exist from that date forward.
    const startDate = request.authoredOn?.slice(0, 10);
    if (startDate && today < startDate) {
      continue; // med not started yet — no slots today
    }
    const slug = requestSlug(request);
    const times = request.dosageInstruction?.flatMap((d) => d.timing?.repeat?.timeOfDay ?? []) ?? [];

    for (const time of times) {
      const scheduled = new Date(`${today}T${time}`); // local time; seconds required
      if (Number.isNaN(scheduled.getTime())) {
        continue;
      }
      if (now.getTime() - scheduled.getTime() < GRACE_MINUTES * 60_000) {
        continue; // not yet past due + grace
      }

      // Same logical-slot identifier the UI writes when a dose is logged
      // (taken OR skipped/missed) — any log means no reminder.
      const slotValue = `${slug}-${today}T${time.slice(0, 5)}`;
      const logged = await medplum.searchOne('MedicationAdministration', {
        identifier: `${ADMIN_IDENT_SYSTEM}|${slotValue}`,
      });
      if (logged) {
        continue;
      }

      const reminderValue = `reminder/${slug}/${today}T${time.slice(0, 5)}`;
      const medName = request.medicationReference?.display ?? 'Medication';
      const reminder = await medplum.createResourceIfNoneExist<CommunicationRequest>(
        {
          resourceType: 'CommunicationRequest',
          status: 'active',
          subject: request.subject,
          about: [{ reference: `MedicationRequest/${request.id}` }],
          medium: [
            { coding: [{ system: CS_MEDIUM, code: 'push', display: 'Push notification' }] },
          ],
          occurrenceDateTime: scheduled.toISOString(),
          authoredOn: now.toISOString(),
          payload: [
            {
              // Neutral wording on purpose: "not logged yet", never "missed" —
              // dose status is only ever set by the user.
              contentString: `Dose reminder: ${medName} scheduled for ${time.slice(0, 5)} has not been logged yet.`,
            },
          ],
          identifier: [{ system: REMINDER_IDENT_SYSTEM, value: reminderValue }],
        },
        `identifier=${REMINDER_IDENT_SYSTEM}|${reminderValue}`
      );
      created.push(reminder);
    }
  }

  return created;
}

/** Cron invocations carry no useful input; tests pass Parameters{now} for a
 * deterministic clock. Anything else falls back to the wall clock. */
function resolveNow(input: unknown): Date {
  const resource = input as Resource | undefined;
  if (resource?.resourceType === 'Parameters') {
    const value = (resource as Parameters).parameter?.find((p) => p.name === 'now')?.valueDateTime;
    if (value) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
  }
  return new Date();
}

/**
 * Stable per-request slug used in slot identifiers: the project business
 * identifier when present (survives export/re-import), else the server id.
 * Must match the frontend's slug derivation or slot identities diverge.
 */
function requestSlug(request: MedicationRequest): string {
  const local = request.identifier?.find((i) => i.system === REQUEST_IDENT_SYSTEM);
  return local?.value ?? (request.id as string);
}

/**
 * YYYY-MM-DD from the process-local wall clock — deliberately NOT UTC, so
 * "today" and slot dates line up with what the owner's UI shows.
 */
function localDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
