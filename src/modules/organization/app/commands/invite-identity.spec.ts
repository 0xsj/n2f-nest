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
  InvitationReader,
  InvitationWriter,
  MembershipReader,
} from '../ports/index.js';
import { InviteIdentity } from './invite-identity.js';

const parsed = [
  '01900000-0000-7000-8000-000000000001',
  '01900000-0000-7000-8000-000000000002',
  '01900000-0000-7000-8000-000000000003',
  '01900000-0000-7000-8000-000000000004',
  '01900000-0000-7000-8000-000000000005',
].map((value) => parse(value));
if (parsed.some((result) => !result.ok)) throw new Error('invitation IDs invalid');
const ids: ID[] = parsed.map((result) => {
  if (!result.ok) throw new Error('invitation ID invalid');
  return result.value;
});

const now = new Date('2026-09-20T00:00:00.000Z');

function work() {
  const result = restoreWork({
    workId: ids[0]!,
    correlationId: ids[1]!,
    correlationSource: 'local',
    operation: operation('organization.invitation.create').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'request',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

class FixedIds implements IDGenerator {
  private readonly sequence = new Sequence([ids[3]!, ids[4]!]);
  newId(): Result<ID, Failure> { return this.sequence.newId(); }
}

function setup(actorRole: 'owner' | 'member' = 'owner', existing = false) {
  let committed: Parameters<InvitationWriter['commit']>[0] | undefined;
  const owner = Membership.add({
    id: ids[2]!,
    organizationId: ids[2]!,
    identityId: ids[0]!,
    role: 'owner',
    createdAt: now,
  });
  if (!owner.ok) throw new Error(owner.error.message);
  const actors: CurrentActorReader = {
    findCurrent: async () => ok({ identityId: ids[0]! }),
  };
  const identities: IdentityReferenceReader = {
    findActive: async () => ok({ identityId: ids[1]! }),
  };
  const memberships: MembershipReader = {
    findById: async () => ok(null),
    findActiveForIdentity: async () =>
      actorRole === 'owner' ? ok(owner.value)
        : ok(null),
    findForIdentity: async () => ok(existing ? owner.value : null),
  };
  const invitations: InvitationReader = {
    findPendingForIdentity: async () => ok(null),
  };
  const writer: InvitationWriter = {
    commit: async (input) => {
      committed = input;
      return ok(undefined);
    },
  };
  return {
    committed: () => committed,
    useCase: new InviteIdentity({
      clock: new FakeClock(now),
      ids: new FixedIds(),
      actors,
      identities,
      memberships,
      invitations,
      writer,
    }),
  };
}

describe('InviteIdentity', () => {
  it('allows an owner to create a pending invitation', async () => {
    const { committed, useCase } = setup();
    const result = await useCase.execute({
      sessionToken: new SecretString('session-token'),
      organizationId: ids[2]!,
      identityId: ids[1]!,
      role: 'member',
      work: work(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.identityId).toBe(ids[1]);
      expect(result.value.status).toBe('pending');
      expect(result.value.expiresAt).toEqual(new Date('2026-09-27T00:00:00.000Z'));
    }
    expect(committed()?.invitation).toBeDefined();
    expect(committed()?.event.type).toBe('organization.invitation.created.v1');
  });

  it('rejects a non-owner before writing', async () => {
    const { committed, useCase } = setup('member');
    const result = await useCase.execute({
      sessionToken: new SecretString('session-token'),
      organizationId: ids[2]!,
      identityId: ids[1]!,
      role: 'member',
      work: work(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('organization.invitation.forbidden');
    expect(committed()).toBeUndefined();
  });

  it('rejects an identity that is already a member', async () => {
    const { committed, useCase } = setup('owner', true);
    const result = await useCase.execute({
      sessionToken: new SecretString('session-token'),
      organizationId: ids[2]!,
      identityId: ids[1]!,
      role: 'member',
      work: work(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('organization.invitation.membership_exists');
    expect(committed()).toBeUndefined();
  });
});
