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
  IdentityReferenceReader,
  MembershipReader,
  MembershipWriter,
} from '../ports/index.js';
import { AddMembership } from './add-membership.js';

const parsed = [
  '01900000-0000-7000-8000-000000000001',
  '01900000-0000-7000-8000-000000000002',
  '01900000-0000-7000-8000-000000000003',
  '01900000-0000-7000-8000-000000000004',
  '01900000-0000-7000-8000-000000000005',
  '01900000-0000-7000-8000-000000000006',
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
    operation: operation('organization.membership.add').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'request',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function owner() {
  const result = Membership.add({
    id: ids[2]!,
    organizationId: ids[3]!,
    identityId: ids[0]!,
    role: 'owner',
    createdAt: now,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

class FixedIds implements IDGenerator {
  private readonly sequence = new Sequence([ids[4]!, ids[5]!]);

  newId(): Result<ID, Failure> {
    return this.sequence.newId();
  }
}

function setup(actorRole: 'owner' | 'member' = 'owner', target: boolean = true) {
  let committed: Parameters<MembershipWriter['commit']>[0] | undefined;
  const actors: CurrentActorReader = {
    findCurrent: async () => ok({ identityId: ids[0]! }),
  };
  const identities: IdentityReferenceReader = {
    findActive: async () => target ? ok({ identityId: ids[1]! }) : ok(null),
  };
  const memberships: MembershipReader = {
    findById: async () => ok(null),
    findActiveForIdentity: async () =>
      actorRole === 'owner' ? ok(owner()) : ok(null),
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
    useCase: new AddMembership({
      clock: new FakeClock(now),
      ids: new FixedIds(),
      actors,
      identities,
      memberships,
      writer,
    }),
  };
}

describe('AddMembership', () => {
  it('allows an owner to add an active identity as a member', async () => {
    const { committed, useCase } = setup();

    const result = await useCase.execute({
      sessionToken: new SecretString('session-token'),
      organizationId: ids[3]!,
      identityId: ids[1]!,
      role: 'member',
      work: work(),
    });

    expect(result).toEqual(
      ok({ membershipId: ids[4], identityId: ids[1], role: 'member' }),
    );
    expect(committed()?.membership.identityId).toBe(ids[1]);
    expect(committed()?.event.type).toBe('organization.membership.added.v1');
  });

  it('rejects a missing or inactive identity before writing', async () => {
    const { committed, useCase } = setup('owner', false);

    const result = await useCase.execute({
      sessionToken: new SecretString('session-token'),
      organizationId: ids[3]!,
      identityId: ids[1]!,
      role: 'member',
      work: work(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('organization.membership.identity_not_found');
    expect(committed()).toBeUndefined();
  });

  it('rejects a non-owner before checking the target identity', async () => {
    const { committed, useCase } = setup('member');

    const result = await useCase.execute({
      sessionToken: new SecretString('session-token'),
      organizationId: ids[3]!,
      identityId: ids[1]!,
      role: 'member',
      work: work(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('organization.membership.add_forbidden');
    expect(committed()).toBeUndefined();
  });
});
