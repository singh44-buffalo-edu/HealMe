/**
 * Tests for the break-glass bot (src/break-glass.ts) against @medplum/mock's
 * in-memory FHIR repo — no running server needed. Covers the full
 * activate/restore dance: emergency-policy shape (full read, nothing else),
 * access[] swap + first-write-wins backup, AuditEvent + owner Communication,
 * idempotent double-activation, restore-without-activate noop, both input
 * shapes (Parameters and Communication), and defensive noops on bad input.
 * Run: `cd backend-bots && npm test` (part of `make check`).
 */
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import type { BotEvent, MedplumClient } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type {
  Bundle,
  Communication,
  Parameters,
  ProjectMembership,
  Resource,
  SearchParameter,
} from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { beforeAll, describe, expect, it } from 'vitest';
import { EMERGENCY_POLICY_NAME, handler } from './break-glass';

const CS_CARE = 'https://healmedaily.local/fhir/CodeSystem/care-circle';
const IDENT_BASIC = 'https://healmedaily.local/fhir/identifier/basic';

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

describe('break-glass', () => {
  it('activates: swaps to the emergency policy, backs up, audits, notifies the owner', async () => {
    const medplum = new MockClient();
    const membership = await makeMembership(medplum);

    const result = await handler(
      medplum as unknown as MedplumClient,
      makeEvent(activateParams(membership.id as string))
    );
    expect(result.action).toBe('activated');

    // Emergency policy created with the right shape: full read, nothing else
    const policy = await medplum.searchOne('AccessPolicy', { name: EMERGENCY_POLICY_NAME });
    expect(policy).toBeDefined();
    expect(policy?.resource).toEqual([{ resourceType: '*', readonly: true }]);

    // Membership now bound to the emergency policy
    const updated = await medplum.readResource('ProjectMembership', membership.id as string);
    expect(updated.access).toEqual([{ policy: { reference: `AccessPolicy/${policy?.id}` } }]);

    // Backup Basic holds the original access[]
    const backup = await medplum.searchOne('Basic', {
      identifier: `${IDENT_BASIC}|break-glass-backup-${membership.id}`,
    });
    expect(backup).toBeDefined();
    const saved = JSON.parse(
      backup?.extension?.find((e) => e.url.endsWith('break-glass-original-access'))?.valueString as string
    );
    expect(saved[0].policy.reference).toBe('AccessPolicy/original');

    // Permanent AuditEvent + owner Communication
    const audits = await medplum.searchResources('AuditEvent');
    expect(audits.some((a) => a.type?.system === CS_CARE && a.type?.code === 'break-glass')).toBe(true);
    const comms = await medplum.searchResources('Communication');
    const note = comms.find((c) => c.payload?.[0]?.contentString?.includes('Emergency access used by'));
    expect(note?.payload?.[0]?.contentString).toContain('Alice Careful');
    expect(note?.payload?.[0]?.contentString).toContain('expires');
  });

  it('is idempotent: a second activate is a no-op and keeps the original backup', async () => {
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

    const backup = await medplum.searchOne('Basic', {
      identifier: `${IDENT_BASIC}|break-glass-backup-${membership.id}`,
    });
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

  it('unknown input is a logged no-op', async () => {
    const medplum = new MockClient();
    const result = await handler(
      medplum as unknown as MedplumClient,
      makeEvent({ resourceType: 'Patient' })
    );
    expect(result.action).toBe('noop');
    expect(result.reason).toBe('unrecognized input');
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
