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
import { Invitation, Membership } from '../../domain/index.js';
import type {
  CurrentActorReader,
  InvitationReader,
  InvitationWriter,
  MembershipReader,
} from '../ports/index.js';
import { RevokeInvitation } from './revoke-invitation.js';

const parsed = [
  '01900000-0000-7000-8000-000000000001',
  '01900000-0000-7000-8000-000000000002',
  '01900000-0000-7000-8000-000000000003',
  '01900000-0000-7000-8000-000000000004',
  '01900000-0000-7000-8000-000000000005',
].map((value) => parse(value));
if (parsed.some((result) => !result.ok)) throw new Error('revocation IDs invalid');
const ids: ID[] = parsed.map((result) => {
  if (!result.ok) throw new Error('revocation ID invalid');
  return result.value;
});

const createdAt = new Date('2026-09-20T00:00:00.000Z');
const revokedAt = new Date('2026-09-21T00:00:00.000Z');

function work() {
  const result = restoreWork({
    workId: ids[0]!,
    correlationId: ids[1]!,
    correlationSource: 'local',
    operation: operation('organization.invitation.revoke').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'request',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function invitation() {
  const result = Invitation.issue({
    id: ids[2]!,
    organizationId: ids[3]!,
    identityId: ids[4]!,
    role: 'member',
    createdAt,
    expiresAt: new Date('2026-09-27T00:00:00.000Z'),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

class FixedIds implements IDGenerator {
  private readonly sequence = new Sequence([ids[1]!]);
  newId(): Result<ID, Failure> { return this.sequence.newId(); }
}

function setup(actorRole: 'owner' | 'member' = 'owner') {
  const owner = Membership.add({
    id: ids[3]!,
    organizationId: ids[3]!,
    identityId: ids[0]!,
    role: actorRole,
    createdAt,
  });
  if (!owner.ok) throw new Error(owner.error.message);
  let committed: Parameters<InvitationWriter['commit']>[0] | undefined;
  const actors: CurrentActorReader = {
    findCurrent: async () => ok({ identityId: ids[0]! }),
  };
  const invitations: InvitationReader = {
    findById: async () => ok(invitation()),
    findPendingForIdentity: async () => ok(invitation()),
  };
  const memberships: MembershipReader = {
    findById: async () => ok(null),
    findActiveForIdentity: async () => ok(owner.value),
    findForIdentity: async () => ok(null),
  };
  const writer: InvitationWriter = {
    commit: async (input) => {
      committed = input;
      return ok(undefined);
    },
  };
  return {
    committed: () => committed,
    useCase: new RevokeInvitation({
      clock: new FakeClock(revokedAt),
      ids: new FixedIds(),
      actors,
      invitations,
      memberships,
      writer,
    }),
  };
}

describe('RevokeInvitation', () => {
  it('allows an owner to revoke a pending invitation', async () => {
    const { committed, useCase } = setup();
    const result = await useCase.execute({
      sessionToken: new SecretString('session-token'),
      organizationId: ids[3]!,
      invitationId: ids[2]!,
      work: work(),
    });
    expect(result).toEqual(ok({ invitationId: ids[2], status: 'revoked' }));
    expect(committed()?.invitation.status).toBe('revoked');
    expect(committed()?.event.type).toBe('organization.invitation.revoked.v1');
  });

  it('rejects a non-owner before writing', async () => {
    const { committed, useCase } = setup('member');
    const result = await useCase.execute({
      sessionToken: new SecretString('session-token'),
      organizationId: ids[3]!,
      invitationId: ids[2]!,
      work: work(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('organization.invitation.revoke_forbidden');
    expect(committed()).toBeUndefined();
  });
});
