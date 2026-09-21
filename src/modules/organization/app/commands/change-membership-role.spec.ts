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
import { ChangeMembershipRole } from './change-membership-role.js';

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
    operation: operation('organization.membership.role.change').value,
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
  const owner = membership(ids[3]!, ids[0]!, 'owner');
  const target = membership(ids[2]!, ids[3]!, targetRole);
  const actorMembership = actorRole === 'owner' ? owner : membership(ids[3]!, ids[0]!, 'member');
  let committed: Parameters<MembershipWriter['commit']>[0] | undefined;

  const actors: CurrentActorReader = {
    findCurrent: async () => ok({ identityId: ids[0]! }),
  };
  const memberships: MembershipReader = {
    findById: async () => ok(target),
    findActiveForIdentity: async () => ok(actorMembership),
  };
  const writer: MembershipWriter = {
    commit: async (input) => {
      committed = input;
      return ok(undefined);
    },
  };

  return {
    committed: () => committed,
    useCase: new ChangeMembershipRole({
      clock: new FakeClock(now),
      ids: new FixedIds(),
      actors,
      memberships,
      writer,
    }),
  };
}

describe('ChangeMembershipRole', () => {
  it('allows an owner to change an active member role atomically', async () => {
    const { committed, useCase } = setup();

    const result = await useCase.execute({
      sessionToken: new SecretString('session-token'),
      organizationId: ids[2]!,
      membershipId: ids[2]!,
      role: 'admin',
      work: work(),
    });

    expect(result).toEqual(ok({ membershipId: ids[2], role: 'admin' }));
    expect(committed()?.membership.role).toBe('admin');
    expect(committed()?.event.type).toBe('organization.membership.role.changed.v1');
    expect(committed()?.event.payload()).toMatchObject({
      organization_id: ids[2],
      identity_id: ids[3],
      membership_id: ids[2],
      previous_role: 'member',
      role: 'admin',
    });
  });

  it('rejects a non-owner before writing', async () => {
    const { committed, useCase } = setup('member');

    const result = await useCase.execute({
      sessionToken: new SecretString('session-token'),
      organizationId: ids[2]!,
      membershipId: ids[2]!,
      role: 'admin',
      work: work(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('organization.membership.role_forbidden');
    expect(committed()).toBeUndefined();
  });

  it('does not allow this command to demote the owner membership', async () => {
    const { committed, useCase } = setup('owner', 'owner');
    const owner = membership(ids[2]!, ids[3]!, 'owner');

    const result = await useCase.execute({
      sessionToken: new SecretString('session-token'),
      organizationId: ids[2]!,
      membershipId: owner.id,
      role: 'admin',
      work: work(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('organization.membership.owner_locked');
    expect(committed()).toBeUndefined();
  });
});
