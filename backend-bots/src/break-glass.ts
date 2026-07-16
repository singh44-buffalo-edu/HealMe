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
 * Invoked on demand ($execute) — no Subscription. Input is either a
 * Parameters resource (parameter 'membership' + optional 'action'/'event-id')
 * or a Communication whose first payload carries the membership id.
 * Defensive: unrecognized input is a logged no-op. This bot never touches
 * clinical data — only access bindings, audit, and notification.
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

export const EMERGENCY_POLICY_NAME = 'care-circle/emergency-24h';
export const EMERGENCY_WINDOW_HOURS = 24;

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

function normalizeMembershipId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.startsWith('ProjectMembership/') ? value.split('/')[1] : value;
}

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

async function activate(
  medplum: MedplumClient,
  membership: ProjectMembership,
  explicitEventId: string | undefined
): Promise<BreakGlassResult> {
  const membershipId = membership.id as string;
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
