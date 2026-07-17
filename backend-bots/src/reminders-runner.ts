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
 * Timezone (the part that makes slot identity work): the bot runs inside the
 * medplum-server container, whose wall clock is UTC — but the frontend
 * derives slot identifiers in the BROWSER's local zone
 * (frontend/src/fhir.ts localDateString/slotIdentValue). So this bot never
 * trusts the process zone: it reads the owner's IANA zone from the
 * app-config Basic (identifier {IDENT}/app-config|app-config, extension
 * app-config-time-zone — seeded by scripts/seed.py from HMD_TIME_ZONE in
 * .env) and derives "today" and slot instants in THAT zone via
 * Intl.DateTimeFormat. If the config is missing or the zone is invalid it
 * falls back to UTC with a logged warning — reminders then run on UTC slot
 * identity, which only matches the UI for a UTC owner; run `make seed`.
 *
 * Slot identity matches the frontend exactly (frontend/src/fhir.ts
 * slotIdentValue): `{request-slug}-{YYYY-MM-DD}T{HH:MM}` in the owner's
 * zone, under the medication-administration identifier system, so a dose
 * logged in the UI is always seen here.
 *
 * Where it sits: deployed by scripts/deploy_bots.py, which sets
 * Bot.cronString (every 15 minutes) — Medplum's scheduler invokes it
 * directly (requires the 'cron' project feature; deploy_bots.py enables it
 * as super admin) — and Bot.auditEventTrigger=on-output so the ~96 empty
 * scans a day don't flood the AuditEvent table (only runs that create
 * reminders, or hit the missing-timezone warning, log output and get an
 * execution record). Because every run rescans from scratch and all writes
 * are conditional creates on stable identifiers, a missed cron tick is
 * harmless: the next tick produces the identical result.
 */

import { BotEvent, MedplumClient } from '@medplum/core';
import type {
  CommunicationRequest,
  MedicationRequest,
  Parameters,
  Resource,
} from '@medplum/fhirtypes';

// The vmcontext bot runtime provides console (its output is what
// Bot.auditEventTrigger=on-output keys on), but the tsconfig lib is bare
// ES2022 — declare the sliver we use instead of widening the lib for all bots.
declare const console: { log: (message: string) => void };

const BASE = 'https://healmedaily.local/fhir';
const IDENT = `${BASE}/identifier`;
const ADMIN_IDENT_SYSTEM = `${IDENT}/medication-administration`;
const REQUEST_IDENT_SYSTEM = `${IDENT}/medication-request`;
const REMINDER_IDENT_SYSTEM = `${IDENT}/communication-request`;
const APP_CONFIG_IDENT_SYSTEM = `${IDENT}/app-config`;
const EXT_TIME_ZONE = `${BASE}/StructureDefinition/app-config-time-zone`;
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
 * Touches: reads Basic (app-config timezone), MedicationRequest +
 * MedicationAdministration; conditionally creates CommunicationRequest.
 * NEVER writes MedicationAdministration — see the medical-safety rule in the
 * file header. Idempotent at any frequency.
 */
export async function handler(
  medplum: MedplumClient,
  event: BotEvent<Parameters | Resource | undefined>
): Promise<CommunicationRequest[]> {
  const timeZone = await resolveTimeZone(medplum);
  const now = resolveNow(event.input);
  const today = zonedDateString(now, timeZone);
  // Also scan the previous local day: a late-evening slot (e.g. 22:30) only
  // clears its 90-min grace AFTER local midnight, by which point `today` has
  // rolled over and would never look back at that slot. Reminders are
  // idempotent (createResourceIfNoneExist by date-stamped identifier), so
  // re-scanning yesterday every run is safe. Older overdue slots are ignored
  // by design — a reminder a day+ late is noise, not a nudge.
  const scanDates = [previousDateString(today), today];
  // Start of the current local day. A slot only earns a reminder while its
  // due-instant (scheduled + grace) sits in [todayStart, now]: today's overdue
  // slots qualify as before, plus a yesterday slot that crossed midnight into
  // today — but NOT yesterday's daytime slots, which became overdue yesterday
  // and would only be day-late noise now.
  const todayStart = zonedInstant(today, '00:00:00', timeZone).getTime();
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
    // authoredOn is the medication start anchor (FHIR-MAPPING.md §2), resolved
    // to the OWNER's local calendar date so it compares against scanDate (a
    // raw UTC slice of an evening dateTime would land a day off).
    const startDate = localCalendarDate(request.authoredOn, timeZone);
    const slug = requestSlug(request);
    // Only the first dosageInstruction — the frontend (fhir.ts loadMeds) and
    // the Pi dispenser both use dosageInstruction[0]; expanding all of them
    // would remind for slots the app never shows.
    const times = request.dosageInstruction?.[0]?.timing?.repeat?.timeOfDay ?? [];

    for (const scanDate of scanDates) {
      if (startDate && scanDate < startDate) {
        continue; // med not started yet on this date — no slots
      }
      for (const time of times) {
        // The instant this wall-clock slot occurs in the OWNER's zone.
        const scheduled = zonedInstant(scanDate, time, timeZone);
        if (Number.isNaN(scheduled.getTime())) {
          continue;
        }
        const dueInstant = scheduled.getTime() + GRACE_MINUTES * 60_000;
        if (dueInstant > now.getTime()) {
          continue; // not yet past due + grace
        }
        if (dueInstant < todayStart) {
          continue; // became overdue before today — stale, not a fresh nudge
        }

        // Same logical-slot identifier the UI writes when a dose is logged
        // (taken OR skipped/missed) — any log means no reminder.
        const slotValue = `${slug}-${scanDate}T${time.slice(0, 5)}`;
        const logged = await medplum.searchOne('MedicationAdministration', {
          identifier: `${ADMIN_IDENT_SYSTEM}|${slotValue}`,
        });
        if (logged) {
          continue;
        }

        const reminderValue = `reminder/${slug}/${scanDate}T${time.slice(0, 5)}`;
        const medName = request.medicationReference?.display ?? 'Medication';
        const reminder = await medplum.createResourceIfNoneExist<CommunicationRequest>(
          {
            resourceType: 'CommunicationRequest',
            status: 'active',
            subject: request.subject,
            about: [{ reference: `MedicationRequest/${request.id}` }],
            medium: [{ coding: [{ system: CS_MEDIUM, code: 'push', display: 'Push notification' }] }],
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
  }

  if (created.length > 0) {
    // Deliberate output: with auditEventTrigger=on-output this is what earns
    // a reminder-creating run its execution AuditEvent.
    console.log(`[reminders-runner] ${created.length} reminder(s) exist for overdue slots`);
  }
  return created;
}

/**
 * The owner's IANA timezone from the app-config Basic (seeded by
 * scripts/seed.py from HMD_TIME_ZONE). Missing config or an invalid zone
 * falls back to UTC — with a logged warning, because UTC slot identity only
 * matches the UI when the owner's browser really is on UTC.
 */
async function resolveTimeZone(medplum: MedplumClient): Promise<string> {
  const config = await medplum.searchOne('Basic', {
    identifier: `${APP_CONFIG_IDENT_SYSTEM}|app-config`,
  });
  const zone = config?.extension?.find((e) => e.url === EXT_TIME_ZONE)?.valueString;
  if (!zone) {
    console.log(
      '[reminders-runner] WARNING: no app-config timezone found — falling back to UTC ' +
        '(slot identity may not match the UI); run `make seed` with HMD_TIME_ZONE set'
    );
    return 'UTC';
  }
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    return zone;
  } catch (_err) {
    console.log(
      `[reminders-runner] WARNING: invalid app-config timezone '${zone}' — falling back to UTC`
    );
    return 'UTC';
  }
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
 * YYYY-MM-DD calendar date of instant `d` in `timeZone` — the owner-local
 * "today", NEVER the container's (UTC) date, so "today" and slot dates line
 * up with what the owner's UI shows. en-CA is the locale whose date format
 * is already YYYY-MM-DD.
 */
export function zonedDateString(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** The calendar date one day before `date` ("YYYY-MM-DD"). UTC-midnight
 * arithmetic on a date-only string is safe here — only the date label matters,
 * not an instant, so DST never enters into it. */
export function previousDateString(date: string): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
}

/** A FHIR date/dateTime -> its owner-local calendar date, matching the
 * frontend's localCalendarDate (fhir.ts). A date-only value passes through; a
 * value with a time is resolved through `timeZone`. Empty/undefined -> ''. */
export function localCalendarDate(value: string | undefined, timeZone: string): string {
  if (!value) {
    return '';
  }
  return value.length > 10 ? zonedDateString(new Date(value), timeZone) : value.slice(0, 10);
}

/**
 * The absolute instant at which wall-clock `date`T`time` occurs in
 * `timeZone` (no date/time libraries in vmcontext, so: take the UTC reading
 * of that wall-clock, subtract the zone's offset, then re-derive the offset
 * at the corrected instant once more to settle DST edges). Invalid input
 * yields an Invalid Date, matching `new Date(...)` semantics upstream.
 */
export function zonedInstant(date: string, time: string, timeZone: string): Date {
  const utcGuess = new Date(`${date}T${time}Z`);
  if (Number.isNaN(utcGuess.getTime())) {
    return utcGuess;
  }
  const once = utcGuess.getTime() - tzOffsetMs(utcGuess, timeZone);
  const settled = utcGuess.getTime() - tzOffsetMs(new Date(once), timeZone);
  return new Date(settled);
}

/** Offset (ms ahead of UTC) that `timeZone` observes at instant `at`. */
function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24, // some ICU builds render midnight as '24'
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - at.getTime();
}
