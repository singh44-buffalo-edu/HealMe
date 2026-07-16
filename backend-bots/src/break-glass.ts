/**
 * Bot: care-circle break-glass (FHIR-MAPPING.md §10)
 *
 * Emergency access swap for a care-circle member. On activate: the member's
 * ProjectMembership.access[] is backed up into a Basic resource (local code
 * break-glass-backup, idempotent per event, stamped with the window expiry),
 * a permanent AuditEvent (local code break-glass) is written BEFORE the swap,
 * the membership is swapped to the shared read-only emergency policy
 * ('care-circle/emergency-24h', created — and shape-reconciled — if needed),
 * and the owner is notified via a Communication. A second invocation with
 * action=restore puts the original access[] back from the backup and audits
 * that too.
 *
 * Two triggers (both wired by scripts/deploy_bots.py, subscription=None):
 *  - On demand ($execute): Parameters (parameter 'membership' + optional
 *    'action'/'event-id') or a Communication whose first payload carries the
 *    membership id.
 *  - Cron (every 15 min): cron invocations carry no membership, which routes
 *    to the expiry sweep — any backup whose stamped expiry has passed gets
 *    its membership restored automatically. This is what makes the 24h
 *    window self-enforcing instead of merely advertised.
 * Input that names no membership (cron payloads included) runs the sweep —
 * harmless and idempotent. This bot never touches clinical data — only
 * access bindings, audit, and notification.
 *
 * ⚠️ Requires a project-admin membership: ProjectMembership is a
 * project-admin resource type, so a plain bot cannot read or update it (the
 * server strips those types from every non-admin principal's policy).
 * deploy_bots.py sets admin=true on this bot's ProjectMembership via the
 * documented admin endpoint (POST admin/projects/{id}/members/{membershipId},
 * docs.medplum.com/docs/auth/user-management-guide). Without that flag the
 * membership read below fails — and the handler deliberately throws (not
 * noops) so the misconfiguration is visible in the execution AuditEvent.
 *
 * The backup/restore dance (why a Basic resource): a member's policy binding
 * lives in ProjectMembership.access[], which activation overwrites. The
 * original bindings — including the %patient parameter care_circle.py set up
 * — are serialized into a Basic (identifier break-glass-backup-{eventId},
 * conditional create so the FIRST backup wins) and put back verbatim on
 * restore, after which the backup is deleted. The first-write-wins backup
 * also carries the expiry stamp, so repeated activations can neither
 * overwrite the true original nor extend the window. The AuditEvents are the
 * permanent record; the backup is deliberately transient.
 *
 * Audit ordering (deliberate): activation writes its AuditEvent BEFORE the
 * access swap, so a crash mid-way can leave an audit for a grant that never
 * landed (over-reporting) but never a live grant with no audit
 * (under-reporting). Repeated activations while a window is already open are
 * audited too — no path grants or holds emergency access silently.
 */

import {
  BotEvent,
  MedplumClient,
  isGone,
  isNotFound,
  normalizeErrorString,
  normalizeOperationOutcome,
} from '@medplum/core';
import type {
  AccessPolicy,
  AuditEvent,
  AuditEventAgent,
  Basic,
  Communication,
  Parameters,
  ProjectMembership,
  Resource,
} from '@medplum/fhirtypes';

// The vmcontext bot runtime provides console (its output is what
// Bot.auditEventTrigger=on-output keys on), but the tsconfig lib is bare
// ES2022 — declare the sliver we use instead of widening the lib for all bots.
declare const console: { log: (message: string) => void };

const BASE = 'https://healmedaily.local/fhir';
const CS_CARE = `${BASE}/CodeSystem/care-circle`;
const IDENT_BASIC = `${BASE}/identifier/basic`;
const EXT_ORIGINAL_ACCESS = `${BASE}/StructureDefinition/break-glass-original-access`;
const EXT_EXPIRES = `${BASE}/StructureDefinition/break-glass-expires`;

/**
 * Name of the shared read-only emergency policy. Looked up by name so every
 * activation reuses one policy resource (FHIR-MAPPING.md §10 "Break-glass");
 * the care_circle.py naming convention marks it as care-circle machinery.
 */
export const EMERGENCY_POLICY_NAME = 'care-circle/emergency-24h';

/**
 * What "everything read-only for 24h" means: the CLINICAL record, enumerated
 * type by type — never a wildcard. A '*' rule would also expose project
 * machinery (ClientApplication carries plaintext secrets, Bot carries code,
 * AccessPolicy/AuditEvent/ProjectMembership map the security posture), which
 * a member could use to mint permanent access outliving the window. Exported
 * so the tests pin the exact allowlist.
 */
export const EMERGENCY_POLICY_RESOURCE_TYPES = [
  'Patient',
  'Observation',
  'MedicationRequest',
  'MedicationAdministration',
  'Medication',
  'Condition',
  'AllergyIntolerance',
  'Immunization',
  'DiagnosticReport',
  'DocumentReference',
  'Device',
  'QuestionnaireResponse',
] as const;

/** Emergency window (owner decision, Phase 9). The expiry is stamped on the
 * backup Basic at activation; the 15-min cron sweep restores any membership
 * whose stamp has passed — enforcement is automatic, not advisory. */
export const EMERGENCY_WINDOW_HOURS = 24;

/**
 * Bot output, recorded in the execution AuditEvent (Medplum logs bot returns
 * there — that is the operational log). 'noop' + reason is the defensive
 * path for duplicate/unusable requests; 'sweep' is the cron path.
 */
export interface BreakGlassResult {
  action: 'activated' | 'restored' | 'noop' | 'sweep';
  membership?: string;
  reason?: string;
  /** Membership ids whose expired windows a sweep restored. */
  restored?: string[];
}

interface ParsedInput {
  membershipId?: string;
  action: 'activate' | 'restore';
  eventId?: string;
}

/**
 * Bot entry point — decodes the input and routes to activate, restore, or
 * (when no membership is named — the cron case) the expiry sweep.
 *
 * @param medplum - project-scoped client injected by the bot runtime; MUST
 *   belong to a project-admin membership (see file header)
 * @param event - `event.input`: Parameters (parameter 'membership' =
 *   ProjectMembership id or reference; optional 'action' activate|restore;
 *   optional 'event-id' correlating an activate/restore pair), a
 *   Communication whose first payload string names the membership, or
 *   anything else (cron invocation) = run the expiry sweep
 * @returns what happened (see BreakGlassResult). Bad/duplicate requests are
 *   noops, but a permission failure reading the membership THROWS — a
 *   break-glass that cannot swap access must fail loudly, not pretend the
 *   member does not exist.
 *
 * Touches: ProjectMembership (access[] swap), AccessPolicy (find-or-create
 * emergency policy), Basic (access backup), AuditEvent, Communication.
 */
export async function handler(
  medplum: MedplumClient,
  event: BotEvent<Parameters | Communication | Resource>
): Promise<BreakGlassResult> {
  const parsed = parseInput(event.input);
  if (!parsed.membershipId) {
    // No membership named — this is the cron tick (or junk input; the sweep
    // is idempotent and safe either way): end any expired windows.
    return sweepExpired(medplum);
  }

  let membership: ProjectMembership;
  try {
    membership = await medplum.readResource('ProjectMembership', parsed.membershipId);
  } catch (err) {
    const outcome = normalizeOperationOutcome(err);
    if (isNotFound(outcome) || isGone(outcome)) {
      return { action: 'noop', reason: 'membership not found' };
    }
    // Anything else is almost certainly the missing admin flag — surface it.
    throw new Error(
      `break-glass cannot read ProjectMembership/${parsed.membershipId} — ` +
        `is the bot's own membership admin=true (deploy_bots.py sets it)? ${normalizeErrorString(err)}`
    );
  }

  if (parsed.action === 'restore') {
    return restore(medplum, membership, parsed.eventId);
  }
  return activate(medplum, membership, parsed.eventId);
}

/** Tolerant input decoding — accepted shapes are listed on the handler doc. */
function parseInput(input: unknown): ParsedInput {
  const resource = input as Resource | undefined;
  if (resource?.resourceType === 'Parameters') {
    const params = (resource as Parameters).parameter ?? [];
    const find = (name: string) => params.find((p) => p.name === name);
    const membershipParam = find('membership');
    const membershipId = normalizeMembershipId(
      membershipParam?.valueString ?? membershipParam?.valueReference?.reference
    );
    const actionRaw = find('action')?.valueCode ?? find('action')?.valueString;
    // Passing an executionPeriod is the "the window is over" signal — restore.
    const action = actionRaw === 'restore' || find('executionPeriod') ? 'restore' : 'activate';
    return { membershipId, action, eventId: find('event-id')?.valueString };
  }
  if (resource?.resourceType === 'Communication') {
    const membershipId = normalizeMembershipId(
      (resource as Communication).payload?.[0]?.contentString
    );
    return { membershipId, action: 'activate' };
  }
  return { action: 'activate' };
}

/** Accept both a bare id and a 'ProjectMembership/{id}' reference. */
function normalizeMembershipId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.startsWith('ProjectMembership/') ? value.split('/')[1] : value;
}

/** Find-or-create the shared emergency policy, reconciling its shape: a
 * policy left behind by an older deploy (the wildcard era) is tightened to
 * the current enumerated clinical allowlist on the next invocation. */
async function ensureEmergencyPolicy(medplum: MedplumClient): Promise<AccessPolicy> {
  const desired: AccessPolicy['resource'] = EMERGENCY_POLICY_RESOURCE_TYPES.map(
    (resourceType) => ({ resourceType, readonly: true })
  );
  const existing = await medplum.searchOne('AccessPolicy', { name: EMERGENCY_POLICY_NAME });
  if (!existing) {
    return medplum.createResource<AccessPolicy>({
      resourceType: 'AccessPolicy',
      name: EMERGENCY_POLICY_NAME,
      resource: desired,
    });
  }
  if (JSON.stringify(existing.resource) !== JSON.stringify(desired)) {
    return medplum.updateResource<AccessPolicy>({ ...existing, resource: desired });
  }
  return existing;
}

function memberName(membership: ProjectMembership): string {
  return membership.profile?.display ?? membership.profile?.reference ?? 'A care-circle member';
}

/** Permanent break-glass AuditEvent: agent = the member whose access changed,
 * subtype = activate|restore. This is the record the "who looked lately"
 * page and any future compliance review search for. */
async function writeAudit(
  medplum: MedplumClient,
  membership: ProjectMembership,
  subtype: 'activate' | 'restore',
  description: string
): Promise<void> {
  // Permanent audit trail — plain create (AuditEvent has no identifier in R4;
  // every attempt is an event worth its own record).
  await medplum.createResource<AuditEvent>({
    resourceType: 'AuditEvent',
    type: { system: CS_CARE, code: 'break-glass', display: 'Break-glass emergency access' },
    subtype: [{ system: CS_CARE, code: subtype }],
    action: 'E',
    recorded: new Date().toISOString(),
    outcome: '0',
    outcomeDesc: description,
    agent: [{ who: membership.profile as AuditEventAgent['who'], requestor: true }],
    source: { observer: { display: 'HealMeDaily break-glass bot' } },
    entity: [{ what: { reference: `ProjectMembership/${membership.id}` } }],
  });
}

/** The backup's stamped expiry in epoch ms; NaN when missing/unparseable
 * (backups from before the expiry stamp existed). */
function backupExpiryMs(backup: Basic): number {
  const raw = backup.extension?.find((e) => e.url === EXT_EXPIRES)?.valueDateTime;
  return raw ? new Date(raw).getTime() : NaN;
}

async function findBackup(medplum: MedplumClient, eventId: string): Promise<Basic | undefined> {
  return medplum.searchOne('Basic', {
    identifier: `${IDENT_BASIC}|break-glass-backup-${eventId}`,
  });
}

/**
 * Grant path: backup access[] (expiry-stamped) -> permanent AuditEvent ->
 * swap to the emergency policy -> owner Communication. The audit lands
 * BEFORE the swap on purpose (see file header). Re-running while a window is
 * open audits the attempt and noops without extending the window (the
 * first-write-wins backup keeps both the true original bindings and the
 * original expiry); re-running after the window expired restores first, then
 * grants a fresh window. Not transactional: a crash mid-way leaves at worst
 * a stale backup Basic + an audit for a swap that never landed — the cron
 * sweep consumes the stale backup within 15 minutes.
 */
async function activate(
  medplum: MedplumClient,
  membership: ProjectMembership,
  explicitEventId: string | undefined
): Promise<BreakGlassResult> {
  const membershipId = membership.id as string;
  // Default event id = membership id: one outstanding break-glass per member
  // unless the caller correlates activate/restore pairs explicitly.
  const eventId = explicitEventId ?? membershipId;
  const emergency = await ensureEmergencyPolicy(medplum);
  const name = memberName(membership);

  if (membership.access?.[0]?.policy?.reference === `AccessPolicy/${emergency.id}`) {
    const existingBackup = await findBackup(medplum, eventId);
    const expiresMs = existingBackup ? backupExpiryMs(existingBackup) : NaN;
    if (existingBackup && !(expiresMs > Date.now())) {
      // The previous window is over (or unstamped — treated as over): end it
      // now, then fall through to grant a FRESH window below. This makes an
      // activation attempt itself enforce the expiry, not just the cron.
      await restore(medplum, membership, eventId);
      membership = await medplum.readResource('ProjectMembership', membershipId);
    } else {
      // Window still open (or active with no backup to restore from). Never
      // skip the audit trail silently — the attempt is recorded either way.
      await writeAudit(
        medplum,
        membership,
        'activate',
        `Repeated break-glass activation for ${name} while a window is already open — ` +
          'ignored; original bindings and expiry are unchanged'
      );
      return { action: 'noop', membership: membershipId, reason: 'already active' };
    }
  }

  // Backup the current access bindings — idempotent per event, and the FIRST
  // backup wins so a re-run can never overwrite the true original or extend
  // the window. The expiry used everywhere below is the one actually stamped
  // on the (possibly pre-existing) backup, not a fresh clock reading.
  const backupIdent = `break-glass-backup-${eventId}`;
  const proposedExpiry = new Date(Date.now() + EMERGENCY_WINDOW_HOURS * 3600 * 1000).toISOString();
  const backup = await medplum.createResourceIfNoneExist<Basic>(
    {
      resourceType: 'Basic',
      code: {
        coding: [{ system: CS_CARE, code: 'break-glass-backup', display: 'Break-glass access backup' }],
        text: 'Break-glass access backup',
      },
      subject: { reference: `ProjectMembership/${membershipId}` },
      created: new Date().toISOString().slice(0, 10),
      identifier: [{ system: IDENT_BASIC, value: backupIdent }],
      extension: [
        { url: EXT_ORIGINAL_ACCESS, valueString: JSON.stringify(membership.access ?? []) },
        { url: EXT_EXPIRES, valueDateTime: proposedExpiry },
      ],
    },
    `identifier=${IDENT_BASIC}|${backupIdent}`
  );
  const expiresMs = backupExpiryMs(backup);
  const expires = Number.isNaN(expiresMs) ? proposedExpiry : new Date(expiresMs).toISOString();

  // Permanent record FIRST, then the swap (ordering rationale: file header).
  await writeAudit(
    medplum,
    membership,
    'activate',
    `Emergency ${EMERGENCY_WINDOW_HOURS}h read access granted to ${name}; expires ${expires}`
  );

  await medplum.updateResource<ProjectMembership>({
    ...membership,
    access: [{ policy: { reference: `AccessPolicy/${emergency.id}` } }],
  });

  const owner = await medplum.searchOne('Patient');
  await medplum.createResource<Communication>({
    resourceType: 'Communication',
    status: 'completed',
    category: [{ coding: [{ system: CS_CARE, code: 'break-glass' }] }],
    subject: owner ? { reference: `Patient/${owner.id}` } : undefined,
    recipient: owner ? [{ reference: `Patient/${owner.id}` }] : undefined,
    sent: new Date().toISOString(),
    payload: [{ contentString: `Emergency access used by ${name} — expires ${expires}` }],
  });

  return { action: 'activated', membership: membershipId };
}

/**
 * Revert path: read the backup Basic -> put the original access[] back (or
 * remove the binding entirely when the member never had one) -> delete the
 * backup -> audit. Without a matching backup this is a noop: restore is only
 * meaningful after an activate with the same event id. A crash mid-way
 * leaves the backup in place, so the cron sweep retries the restore.
 */
async function restore(
  medplum: MedplumClient,
  membership: ProjectMembership,
  explicitEventId: string | undefined
): Promise<BreakGlassResult> {
  const membershipId = membership.id as string;
  const eventId = explicitEventId ?? membershipId;
  const backup = await findBackup(medplum, eventId);
  if (!backup) {
    return { action: 'noop', membership: membershipId, reason: 'no backup found' };
  }

  const raw = backup.extension?.find((e) => e.url === EXT_ORIGINAL_ACCESS)?.valueString;
  let original: ProjectMembership['access'];
  try {
    original = raw ? JSON.parse(raw) : undefined;
  } catch (_err) {
    return { action: 'noop', membership: membershipId, reason: 'backup unparseable' };
  }

  const restored: ProjectMembership = { ...membership };
  if (original && original.length > 0) {
    restored.access = original;
  } else {
    delete restored.access; // original member had no policy binding
  }
  await medplum.updateResource(restored);
  await medplum.deleteResource('Basic', backup.id as string);

  await writeAudit(
    medplum,
    membership,
    'restore',
    `Emergency access ended for ${memberName(membership)}; original access policy restored`
  );

  return { action: 'restored', membership: membershipId };
}

/**
 * Cron path: restore every membership whose backup's stamped expiry has
 * passed. Backups with no parseable stamp (pre-expiry-stamp era) are treated
 * as expired — the fail-safe direction is always ENDING emergency access,
 * never extending it. Idempotent: a healthy system yields an empty sweep.
 * Only sweeps that actually restored something log output, so with
 * Bot.auditEventTrigger=on-output the every-15-min ticks stay out of the
 * AuditEvent table (deploy_bots.py sets the trigger).
 */
async function sweepExpired(medplum: MedplumClient): Promise<BreakGlassResult> {
  const backups = await medplum.searchResources('Basic', {
    code: `${CS_CARE}|break-glass-backup`,
    _count: '100',
  });
  const now = Date.now();
  const restoredIds: string[] = [];

  for (const backup of backups) {
    const expiresMs = backupExpiryMs(backup);
    if (expiresMs > now) {
      continue; // window still open (NaN — unstamped — falls through: expired)
    }
    const membershipId = backup.subject?.reference?.split('/')[1];
    if (!membershipId) {
      continue;
    }
    let membership: ProjectMembership;
    try {
      membership = await medplum.readResource('ProjectMembership', membershipId);
    } catch (_err) {
      continue; // membership deleted — no live access to end
    }
    const eventId = backup.identifier
      ?.find((i) => i.system === IDENT_BASIC)
      ?.value?.replace('break-glass-backup-', '');
    const result = await restore(medplum, membership, eventId);
    if (result.action === 'restored') {
      restoredIds.push(membershipId);
    }
  }

  if (restoredIds.length === 0) {
    return { action: 'sweep', reason: 'no expired windows' };
  }
  console.log(`[break-glass] sweep restored ${restoredIds.length} expired window(s)`);
  return { action: 'sweep', restored: restoredIds };
}
