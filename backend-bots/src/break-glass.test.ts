/**
 * Tests for the break-glass bot (src/break-glass.ts) against @medplum/mock's
 * in-memory FHIR repo — no running server needed (NOTE: MockClient does not
 * enforce access control, so the project-admin requirement in the bot header
 * is exercised by the live smoke path, not here). Covers the full
 * activate/restore dance: emergency-policy shape (enumerated clinical
 * read-only types — never wildcard, never project machinery) including the
 * tightening of a legacy wildcard policy, audit-BEFORE-swap ordering,
 * access[] swap + first-write-wins expiry-stamped backup, owner
 * Communication, the always-audited already-active attempt, the cron expiry
 * sweep (restores expired windows, leaves open ones), re-activation after
 * expiry granting a fresh window, restore-without-activate noop, both input
 * shapes (Parameters and Communication), and defensive noops on bad input.
 * Run: `cd backend-bots && npm test` (part of `make check`).
 */
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import type { BotEvent, MedplumClient } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type {
  Basic,
  Bundle,
  Communication,
  Parameters,
  ProjectMembership,
  Resource,
  SearchParameter,
} from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EMERGENCY_POLICY_NAME,
  EMERGENCY_POLICY_RESOURCE_TYPES,
  EMERGENCY_WINDOW_HOURS,
  handler,
} from './break-glass';

const CS_CARE = 'https://healmedaily.local/fhir/CodeSystem/care-circle';
const IDENT_BASIC = 'https://healmedaily.local/fhir/identifier/basic';
const EXT_EXPIRES = 'https://healmedaily.local/fhir/StructureDefinition/break-glass-expires';

beforeAll(() => {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
  }
});

function makeEvent(input: Resource): BotEvent<Resource> {
  return { bot: { reference: 'Bot/test' }, contentType: 'application/fhir+json', input, secrets: {} };
}

async function makeMembership(medplum: MockClient): Promise<ProjectMembership> {
  return medplum.createResource<ProjectMembership>({
    resourceType: 'ProjectMembership',
    project: { reference: 'Project/p1' },
    user: { reference: 'User/u1', display: 'alice@example.com' },
    profile: { reference: 'RelatedPerson/r1', display: 'Alice Careful' },
    access: [
      {
        policy: { reference: 'AccessPolicy/original' },
        parameter: [{ name: 'patient', valueReference: { reference: 'Patient/123' } }],
      },
    ],
  });
}

function activateParams(membershipId: string): Parameters {
  return {
    resourceType: 'Parameters',
    parameter: [
      { name: 'membership', valueString: membershipId },
      { name: 'action', valueCode: 'activate' },
    ],
  };
}

function restoreParams(membershipId: string): Parameters {
  return {
    resourceType: 'Parameters',
    parameter: [
      { name: 'membership', valueString: membershipId },
      { name: 'action', valueCode: 'restore' },
    ],
  };
}

async function findBackup(medplum: MockClient, membershipId: string): Promise<Basic | undefined> {
  return medplum.searchOne('Basic', {
    identifier: `${IDENT_BASIC}|break-glass-backup-${membershipId}`,
  });
}

/** Rewind the backup's stamped expiry so the window reads as already over. */
async function expireBackup(medplum: MockClient, membershipId: string): Promise<void> {
  const backup = (await findBackup(medplum, membershipId)) as Basic;
  await medplum.updateResource({
    ...backup,
    extension: backup.extension?.map((e) =>
      e.url === EXT_EXPIRES ? { ...e, valueDateTime: '2020-01-01T00:00:00.000Z' } : e
    ),
  });
}

describe('break-glass', () => {
  it('activates: swaps to the emergency policy, backs up with an expiry stamp, audits, notifies the owner', async () => {
    const medplum = new MockClient();
    const membership = await makeMembership(medplum);

    const before = Date.now();
    const result = await handler(
      medplum as unknown as MedplumClient,
      makeEvent(activateParams(membership.id as string))
    );
    expect(result.action).toBe('activated');

    // Emergency policy has the right shape: the enumerated CLINICAL types,
    // read-only — never '*', never project machinery a member could use to
    // outlive the window (ClientApplication secrets, Bot code, policies…).
    const policy = await medplum.searchOne('AccessPolicy', { name: EMERGENCY_POLICY_NAME });
    expect(policy).toBeDefined();
    expect(policy?.resource).toEqual(
      EMERGENCY_POLICY_RESOURCE_TYPES.map((resourceType) => ({ resourceType, readonly: true }))
    );
    const granted = policy?.resource?.map((r) => r.resourceType) ?? [];
    for (const forbidden of ['*', 'ClientApplication', 'Bot', 'AccessPolicy', 'AuditEvent', 'ProjectMembership']) {
      expect(granted).not.toContain(forbidden);
    }

    // Membership now bound to the emergency policy
    const updated = await medplum.readResource('ProjectMembership', membership.id as string);
    expect(updated.access).toEqual([{ policy: { reference: `AccessPolicy/${policy?.id}` } }]);

    // Backup Basic holds the original access[] and the window expiry
    const backup = await findBackup(medplum, membership.id as string);
    expect(backup).toBeDefined();
    const saved = JSON.parse(
      backup?.extension?.find((e) => e.url.endsWith('break-glass-original-access'))?.valueString as string
    );
    expect(saved[0].policy.reference).toBe('AccessPolicy/original');
    const expires = backup?.extension?.find((e) => e.url === EXT_EXPIRES)?.valueDateTime;
    const expectedMs = before + EMERGENCY_WINDOW_HOURS * 3600 * 1000;
    expect(Math.abs(new Date(expires as string).getTime() - expectedMs)).toBeLessThan(60_000);

    // Permanent AuditEvent + owner Communication
    const audits = await medplum.searchResources('AuditEvent');
    expect(audits.some((a) => a.type?.system === CS_CARE && a.type?.code === 'break-glass')).toBe(true);
    const comms = await medplum.searchResources('Communication');
    const note = comms.find((c) => c.payload?.[0]?.contentString?.includes('Emergency access used by'));
    expect(note?.payload?.[0]?.contentString).toContain('Alice Careful');
    expect(note?.payload?.[0]?.contentString).toContain('expires');
  });

  it('tightens a legacy wildcard emergency policy to the enumerated allowlist', async () => {
    const medplum = new MockClient();
    const membership = await makeMembership(medplum);
    await medplum.createResource({
      resourceType: 'AccessPolicy',
      name: EMERGENCY_POLICY_NAME,
      resource: [{ resourceType: '*', readonly: true }], // the pre-fix shape
    });

    await handler(medplum as unknown as MedplumClient, makeEvent(activateParams(membership.id as string)));

    const policies = await medplum.searchResources('AccessPolicy', { name: EMERGENCY_POLICY_NAME });
    expect(policies).toHaveLength(1); // reconciled in place, not duplicated
    expect(policies[0].resource?.map((r) => r.resourceType)).not.toContain('*');
    expect(policies[0].resource).toEqual(
      EMERGENCY_POLICY_RESOURCE_TYPES.map((resourceType) => ({ resourceType, readonly: true }))
    );
  });

  it('writes the permanent AuditEvent BEFORE the access swap', async () => {
    const medplum = new MockClient();
    const membership = await makeMembership(medplum);

    const calls: string[] = [];
    const origCreate = medplum.createResource.bind(medplum);
    const origUpdate = medplum.updateResource.bind(medplum);
    // Non-generic view of the two methods so the spies typecheck.
    const spyable = medplum as unknown as {
      createResource: (r: Resource) => Promise<Resource>;
      updateResource: (r: Resource) => Promise<Resource>;
    };
    vi.spyOn(spyable, 'createResource').mockImplementation(async (r) => {
      calls.push(`create:${r.resourceType}`);
      return origCreate(r);
    });
    vi.spyOn(spyable, 'updateResource').mockImplementation(async (r) => {
      calls.push(`update:${r.resourceType}`);
      return origUpdate(r);
    });

    await handler(medplum as unknown as MedplumClient, makeEvent(activateParams(membership.id as string)));

    const auditAt = calls.indexOf('create:AuditEvent');
    const swapAt = calls.indexOf('update:ProjectMembership');
    expect(auditAt).toBeGreaterThan(-1);
    expect(swapAt).toBeGreaterThan(-1);
    // Ordering rationale (file header): a crash mid-way may over-report
    // (audit for a swap that never landed) but never grant silently.
    expect(auditAt).toBeLessThan(swapAt);
    vi.restoreAllMocks();
  });

  it('re-activation during an open window is a noop that is STILL audited and keeps the original backup', async () => {
    const medplum = new MockClient();
    const membership = await makeMembership(medplum);
    const event = makeEvent(activateParams(membership.id as string));

    await handler(medplum as unknown as MedplumClient, event);
    const second = await handler(medplum as unknown as MedplumClient, event);
    expect(second.action).toBe('noop');
    expect(second.reason).toBe('already active');

    const backups = await medplum.searchResources('Basic', {
      identifier: `${IDENT_BASIC}|break-glass-backup-${membership.id}`,
    });
    expect(backups).toHaveLength(1);
    const saved = JSON.parse(
      backups[0].extension?.find((e) => e.url.endsWith('break-glass-original-access'))?.valueString as string
    );
    expect(saved[0].policy.reference).toBe('AccessPolicy/original'); // never overwritten

    // The attempt itself left a permanent record — nothing is silent.
    const audits = await medplum.searchResources('AuditEvent');
    const activateAudits = audits.filter((a) => a.subtype?.some((s) => s.code === 'activate'));
    expect(activateAudits).toHaveLength(2);
  });

  it('re-activation AFTER the window expired restores first, then grants a fresh window', async () => {
    const medplum = new MockClient();
    const membership = await makeMembership(medplum);
    const event = makeEvent(activateParams(membership.id as string));

    await handler(medplum as unknown as MedplumClient, event);
    await expireBackup(medplum, membership.id as string);

    const again = await handler(medplum as unknown as MedplumClient, event);
    expect(again.action).toBe('activated'); // not 'noop' — the old window is over

    // The stale window was closed (restore audit) and a fresh backup with a
    // future expiry now guards the new one.
    const audits = await medplum.searchResources('AuditEvent');
    expect(audits.some((a) => a.subtype?.some((s) => s.code === 'restore'))).toBe(true);
    const backup = await findBackup(medplum, membership.id as string);
    const expires = backup?.extension?.find((e) => e.url === EXT_EXPIRES)?.valueDateTime;
    expect(new Date(expires as string).getTime()).toBeGreaterThan(Date.now());
    const saved = JSON.parse(
      backup?.extension?.find((e) => e.url.endsWith('break-glass-original-access'))?.valueString as string
    );
    expect(saved[0].policy.reference).toBe('AccessPolicy/original'); // true original, not the emergency binding
  });

  it('restores the original access from the backup and deletes it', async () => {
    const medplum = new MockClient();
    const membership = await makeMembership(medplum);

    await handler(medplum as unknown as MedplumClient, makeEvent(activateParams(membership.id as string)));
    const result = await handler(
      medplum as unknown as MedplumClient,
      makeEvent(restoreParams(membership.id as string))
    );
    expect(result.action).toBe('restored');

    const restored = await medplum.readResource('ProjectMembership', membership.id as string);
    expect(restored.access?.[0]?.policy?.reference).toBe('AccessPolicy/original');
    expect(restored.access?.[0]?.parameter?.[0]?.name).toBe('patient');

    const backup = await findBackup(medplum, membership.id as string);
    expect(backup).toBeUndefined();

    const audits = await medplum.searchResources('AuditEvent');
    expect(audits.some((a) => a.subtype?.some((s) => s.code === 'restore'))).toBe(true);
  });

  it('restore without a prior activation is a no-op', async () => {
    const medplum = new MockClient();
    const membership = await makeMembership(medplum);
    const result = await handler(
      medplum as unknown as MedplumClient,
      makeEvent(restoreParams(membership.id as string))
    );
    expect(result.action).toBe('noop');
    expect(result.reason).toBe('no backup found');
    const untouched = await medplum.readResource('ProjectMembership', membership.id as string);
    expect(untouched.access?.[0]?.policy?.reference).toBe('AccessPolicy/original');
  });

  it('accepts a Communication carrying the membership id (activate)', async () => {
    const medplum = new MockClient();
    const membership = await makeMembership(medplum);
    const input: Communication = {
      resourceType: 'Communication',
      status: 'completed',
      payload: [{ contentString: `ProjectMembership/${membership.id}` }],
    };
    const result = await handler(medplum as unknown as MedplumClient, makeEvent(input));
    expect(result.action).toBe('activated');
  });

  it('cron sweep restores an expired window and leaves the audit trail', async () => {
    const medplum = new MockClient();
    const membership = await makeMembership(medplum);

    await handler(medplum as unknown as MedplumClient, makeEvent(activateParams(membership.id as string)));
    await expireBackup(medplum, membership.id as string);

    // Cron invocations carry no membership — any such input runs the sweep.
    const result = await handler(medplum as unknown as MedplumClient, makeEvent({ resourceType: 'Patient' }));
    expect(result.action).toBe('sweep');
    expect(result.restored).toEqual([membership.id]);

    const restored = await medplum.readResource('ProjectMembership', membership.id as string);
    expect(restored.access?.[0]?.policy?.reference).toBe('AccessPolicy/original');
    expect(await findBackup(medplum, membership.id as string)).toBeUndefined();
    const audits = await medplum.searchResources('AuditEvent');
    expect(audits.some((a) => a.subtype?.some((s) => s.code === 'restore'))).toBe(true);
  });

  it('cron sweep leaves a still-open window untouched', async () => {
    const medplum = new MockClient();
    const membership = await makeMembership(medplum);

    await handler(medplum as unknown as MedplumClient, makeEvent(activateParams(membership.id as string)));
    const result = await handler(medplum as unknown as MedplumClient, makeEvent({ resourceType: 'Patient' }));
    expect(result.action).toBe('sweep');
    expect(result.restored).toBeUndefined();
    expect(result.reason).toBe('no expired windows');

    const still = await medplum.readResource('ProjectMembership', membership.id as string);
    const policy = await medplum.searchOne('AccessPolicy', { name: EMERGENCY_POLICY_NAME });
    expect(still.access?.[0]?.policy?.reference).toBe(`AccessPolicy/${policy?.id}`);
    expect(await findBackup(medplum, membership.id as string)).toBeDefined();
  });

  it('input naming no membership runs the sweep (harmless when nothing is expired)', async () => {
    const medplum = new MockClient();
    const result = await handler(
      medplum as unknown as MedplumClient,
      makeEvent({ resourceType: 'Patient' })
    );
    expect(result.action).toBe('sweep');
    expect(result.reason).toBe('no expired windows');
  });

  it('missing membership is a logged no-op', async () => {
    const medplum = new MockClient();
    const result = await handler(
      medplum as unknown as MedplumClient,
      makeEvent(activateParams('does-not-exist'))
    );
    expect(result.action).toBe('noop');
    expect(result.reason).toBe('membership not found');
  });
});
