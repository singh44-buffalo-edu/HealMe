/**
 * Bot: care-circle break-glass (FHIR-MAPPING.md §10)
 *
 * Emergency access swap for a care-circle member. On activate: the member's
 * ProjectMembership.access[] is backed up into a Basic resource (local code
 * break-glass-backup, idempotent per event), swapped to the shared read-only
 * emergency policy ('care-circle/emergency-24h', created if absent), a
 * permanent AuditEvent (local code break-glass) is written, and the owner is
 * notified via a Communication. A second invocation with action=restore puts
 * the original access[] back from the backup and audits that too.
 *
 * Invoked on demand ($execute) — no Subscription (deployed by
 * scripts/deploy_bots.py with subscription=None). Input is either a
 * Parameters resource (parameter 'membership' + optional 'action'/'event-id')
 * or a Communication whose first payload carries the membership id.
 * Defensive: unrecognized input is a logged no-op. This bot never touches
 * clinical data — only access bindings, audit, and notification.
 *
 * The backup/restore dance (why a Basic resource): a member's policy binding
 * lives in ProjectMembership.access[], which activation overwrites. The
 * original bindings — including the %patient parameter care_circle.py set up
 * — are serialized into a Basic (identifier break-glass-backup-{eventId},
 * conditional create so the FIRST backup wins) and put back verbatim on
 * restore, after which the backup is deleted. The AuditEvents are the
 * permanent record; the backup is deliberately transient.
 *
 * Note the 24h window is advertised, not self-enforcing: nothing expires
 * server-side. Whatever schedules the restore run (owner action or a cron)
 * ends the window; the expiry timestamp in the AuditEvent + owner
 * notification makes an overdue restore auditable.
 */

import { BotEvent, MedplumClient } from '@medplum/core';
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

const BASE = 'https://healmedaily.local/fhir';
const CS_CARE = `${BASE}/CodeSystem/care-circle`;
const IDENT_BASIC = `${BASE}/identifier/basic`;
const EXT_ORIGINAL_ACCESS = `${BASE}/StructureDefinition/break-glass-original-access`;

/**
 * Name of the shared read-only emergency policy. Looked up by name so every
 * activation reuses one policy resource (FHIR-MAPPING.md §10 "Break-glass");
 * the care_circle.py naming convention marks it as care-circle machinery.
 */
export const EMERGENCY_POLICY_NAME = 'care-circle/emergency-24h';
/** Advertised emergency window (owner decision, Phase 9); see file header —
 * enforcement is the restore invocation, not a server-side timer. */
export const EMERGENCY_WINDOW_HOURS = 24;

/**
 * Bot output, recorded in the execution AuditEvent (Medplum logs bot returns
 * there — that is the operational log). 'noop' + reason is the defensive
 * path for bad/duplicate input; it is never an error.
 */
export interface BreakGlassResult {
  action: 'activated' | 'restored' | 'noop';
  membership?: string;
  reason?: string;
}

interface ParsedInput {
  membershipId?: string;
  action: 'activate' | 'restore';
  eventId?: string;
}

/**
 * Bot entry point — decodes the input and routes to activate or restore.
 *
 * @param medplum - project-scoped client injected by the bot runtime
 * @param event - `event.input`: Parameters (parameter 'membership' =
 *   ProjectMembership id or reference; optional 'action' activate|restore;
 *   optional 'event-id' correlating an activate/restore pair) or a
 *   Communication whose first payload string names the membership
 * @returns what happened (see BreakGlassResult); deliberately never throws
 *   on bad input, so a mis-wired caller cannot leave access half-swapped
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
    // Defensive no-op — the returned reason is the log (bot output is recorded
    // in the execution AuditEvent).
    return { action: 'noop', reason: 'unrecognized input' };
  }

  let membership: ProjectMembership;
  try {
    membership = await medplum.readResource('ProjectMembership', parsed.membershipId);
  } catch (_err) {
    return { action: 'noop', reason: 'membership not found' };
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

/** Find-or-create the shared emergency policy (lookup by name keeps repeat
 * activations from minting duplicates). */
async function ensureEmergencyPolicy(medplum: MedplumClient): Promise<AccessPolicy> {
  const existing = await medplum.searchOne('AccessPolicy', { name: EMERGENCY_POLICY_NAME });
  if (existing) {
    return existing;
  }
  return medplum.createResource<AccessPolicy>({
    resourceType: 'AccessPolicy',
    name: EMERGENCY_POLICY_NAME,
    // Full READ of the record for the emergency window — never write access.
    resource: [{ resourceType: '*', readonly: true }],
  });
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
  // activation itself is guarded by the already-active/no-backup checks).
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

/**
 * Grant path: backup access[] -> swap to the emergency policy -> permanent
 * AuditEvent -> owner Communication. Re-running while already active is a
 * noop, and the first-write-wins backup means a double activation can never
 * overwrite the true original bindings. Not transactional: a crash mid-way
 * leaves at worst a stale backup Basic (harmless — restore consumes it); the
 * bot execution itself is always logged in Medplum's own AuditEvents.
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

  if (membership.access?.[0]?.policy?.reference === `AccessPolicy/${emergency.id}`) {
    return { action: 'noop', membership: membershipId, reason: 'already active' };
  }

  // Backup the current access bindings — idempotent per event, and the FIRST
  // backup wins so a re-run can never overwrite the true original.
  const backupIdent = `break-glass-backup-${eventId}`;
  await medplum.createResourceIfNoneExist<Basic>(
    {
      resourceType: 'Basic',
      code: {
        coding: [{ system: CS_CARE, code: 'break-glass-backup', display: 'Break-glass access backup' }],
        text: 'Break-glass access backup',
      },
      subject: { reference: `ProjectMembership/${membershipId}` },
      created: new Date().toISOString().slice(0, 10),
      identifier: [{ system: IDENT_BASIC, value: backupIdent }],
      extension: [{ url: EXT_ORIGINAL_ACCESS, valueString: JSON.stringify(membership.access ?? []) }],
    },
    `identifier=${IDENT_BASIC}|${backupIdent}`
  );

  await medplum.updateResource<ProjectMembership>({
    ...membership,
    access: [{ policy: { reference: `AccessPolicy/${emergency.id}` } }],
  });

  const expires = new Date(Date.now() + EMERGENCY_WINDOW_HOURS * 3600 * 1000).toISOString();
  const name = memberName(membership);
  await writeAudit(
    medplum,
    membership,
    'activate',
    `Emergency ${EMERGENCY_WINDOW_HOURS}h read access granted to ${name}; expires ${expires}`
  );

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
 * meaningful after an activate with the same event id.
 */
async function restore(
  medplum: MedplumClient,
  membership: ProjectMembership,
  explicitEventId: string | undefined
): Promise<BreakGlassResult> {
  const membershipId = membership.id as string;
  const eventId = explicitEventId ?? membershipId;
  const backup = await medplum.searchOne('Basic', {
    identifier: `${IDENT_BASIC}|break-glass-backup-${eventId}`,
  });
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
