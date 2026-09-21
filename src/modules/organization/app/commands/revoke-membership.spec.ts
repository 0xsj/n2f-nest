import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../../shared/clock/index.js';
import { ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import { parse, Sequence, type ID, type IDGenerator } from '../../../../shared/id/index.js';
import {
  anonymous,
  attribution,
  operation,
  restoreWork,
} from '../../../../shared/provenance/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import { Membership } from '../../domain/index.js';
import type {
  CurrentActorReader,
  MembershipReader,
  MembershipWriter,
} from '../ports/index.js';
import { RevokeMembership } from './revoke-membership.js';

const parsed = [
  '01900000-0000-7000-8000-000000000001',
  '01900000-0000-7000-8000-000000000002',
  '01900000-0000-7000-8000-000000000003',
  '01900000-0000-7000-8000-000000000004',
  '01900000-0000-7000-8000-000000000005',
].map((value) => parse(value));
if (parsed.some((result) => !result.ok)) throw new Error('membership IDs invalid');

const ids: ID[] = parsed.map((result) => {
  if (!result.ok) throw new Error('membership ID invalid');
  return result.value;
});

const now = new Date('2026-09-20T00:00:00.000Z');

function work() {
  const result = restoreWork({
    workId: ids[0]!,
    correlationId: ids[1]!,
    correlationSource: 'local',
    operation: operation('organization.membership.revoke').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'request',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function membership(id: ID, identityId: ID, role: 'owner' | 'member') {
  const result = Membership.add({
    id,
    organizationId: ids[2]!,
    identityId,
    role,
    createdAt: now,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

class FixedIds implements IDGenerator {
  private readonly sequence = new Sequence([ids[4]!]);

  newId(): Result<ID, Failure> {
    return this.sequence.newId();
  }
}

function setup(
  actorRole: 'owner' | 'member' = 'owner',
  targetRole: 'owner' | 'member' = 'member',
) {
  const target = membership(ids[3]!, ids[0]!, targetRole);
  const actorMembership = membership(ids[2]!, ids[1]!, actorRole);
  let committed: Parameters<MembershipWriter['commit']>[0] | undefined;

  const actors: CurrentActorReader = {
    findCurrent: async () => ok({ identityId: ids[1]! }),
  };
  const memberships: MembershipReader = {
    findById: async () => ok(target),
    findActiveForIdentity: async () => ok(actorMembership),
    findForIdentity: async () => ok(null),
  };
  const writer: MembershipWriter = {
    commit: async (input) => {
      committed = input;
      return ok(undefined);
    },
  };

  return {
    committed: () => committed,
    useCase: new RevokeMembership({
      clock: new FakeClock(new Date('2026-09-20T00:01:00.000Z')),
      ids: new FixedIds(),
      actors,
      memberships,
      writer,
    }),
  };
}

describe('RevokeMembership', () => {
  it('allows an owner to revoke an active member atomically', async () => {
    const { committed, useCase } = setup();

    const result = await useCase.execute({
      sessionToken: new SecretString('session-token'),
      organizationId: ids[2]!,
      membershipId: ids[3]!,
      work: work(),
    });

    expect(result).toEqual(ok({ membershipId: ids[3], status: 'revoked' }));
    expect(committed()?.membership.status).toBe('revoked');
    expect(committed()?.membership.revokedAt).toEqual(new Date('2026-09-20T00:01:00.000Z'));
    expect(committed()?.event.type).toBe('organization.membership.revoked.v1');
    expect(committed()?.event.payload()).toMatchObject({
      organization_id: ids[2],
      identity_id: ids[0],
      membership_id: ids[3],
      role: 'member',
    });
  });

  it('rejects a non-owner before writing', async () => {
    const { committed, useCase } = setup('member');

    const result = await useCase.execute({
      sessionToken: new SecretString('session-token'),
      organizationId: ids[2]!,
      membershipId: ids[3]!,
      work: work(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('organization.membership.revoke_forbidden');
    expect(committed()).toBeUndefined();
  });

  it('does not allow this command to revoke the owner membership', async () => {
    const { committed, useCase } = setup('owner', 'owner');

    const result = await useCase.execute({
      sessionToken: new SecretString('session-token'),
      organizationId: ids[2]!,
      membershipId: ids[3]!,
      work: work(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('organization.membership.owner_locked');
    expect(committed()).toBeUndefined();
  });
});
