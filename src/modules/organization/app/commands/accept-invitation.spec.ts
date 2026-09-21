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
import { Invitation } from '../../domain/index.js';
import type {
  CurrentActorReader,
  InvitationAcceptanceWriter,
  InvitationReader,
  MembershipReader,
} from '../ports/index.js';
import { AcceptInvitation } from './accept-invitation.js';

const parsed = [
  '01900000-0000-7000-8000-000000000001',
  '01900000-0000-7000-8000-000000000002',
  '01900000-0000-7000-8000-000000000003',
  '01900000-0000-7000-8000-000000000004',
  '01900000-0000-7000-8000-000000000005',
  '01900000-0000-7000-8000-000000000006',
  '01900000-0000-7000-8000-000000000007',
].map((value) => parse(value));
if (parsed.some((result) => !result.ok)) throw new Error('acceptance IDs invalid');
const ids: ID[] = parsed.map((result) => {
  if (!result.ok) throw new Error('acceptance ID invalid');
  return result.value;
});

const createdAt = new Date('2026-09-20T00:00:00.000Z');
const acceptedAt = new Date('2026-09-21T00:00:00.000Z');

function work() {
  const result = restoreWork({
    workId: ids[0]!,
    correlationId: ids[1]!,
    correlationSource: 'local',
    operation: operation('organization.invitation.accept').value,
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
  private readonly sequence = new Sequence([ids[5]!, ids[6]!, ids[1]!]);
  newId(): Result<ID, Failure> { return this.sequence.newId(); }
}

function setup(actorId: ID = ids[4]!) {
  let committed: Parameters<InvitationAcceptanceWriter['commit']>[0] | undefined;
  const actors: CurrentActorReader = {
    findCurrent: async () => ok({ identityId: actorId }),
  };
  const invitations: InvitationReader = {
    findById: async () => ok(invitation()),
    findPendingForIdentity: async () => ok(invitation()),
  };
  const memberships: MembershipReader = {
    findById: async () => ok(null),
    findActiveForIdentity: async () => ok(null),
    findForIdentity: async () => ok(null),
  };
  const writer: InvitationAcceptanceWriter = {
    commit: async (input) => {
      committed = input;
      return ok(undefined);
    },
  };
  return {
    committed: () => committed,
    useCase: new AcceptInvitation({
      clock: new FakeClock(acceptedAt),
      ids: new FixedIds(),
      actors,
      invitations,
      memberships,
      writer,
    }),
  };
}

describe('AcceptInvitation', () => {
  it('accepts for the invited identity and commits membership plus events together', async () => {
    const { committed, useCase } = setup();
    const result = await useCase.execute({
      sessionToken: new SecretString('session-token'),
      organizationId: ids[3]!,
      invitationId: ids[2]!,
      work: work(),
    });

    expect(result).toEqual({
      ok: true,
      value: {
        invitationId: ids[2],
        membershipId: ids[5],
        organizationId: ids[3],
        identityId: ids[4],
        role: 'member',
      },
    });
    expect(committed()?.invitation.status).toBe('accepted');
    expect(committed()?.membership.identityId).toBe(ids[4]);
    expect(committed()?.events.map((event) => event.type)).toEqual([
      'organization.invitation.accepted.v1',
      'organization.membership.added.v1',
    ]);
  });

  it('rejects a different identity before writing', async () => {
    const { committed, useCase } = setup(ids[6]!);
    const result = await useCase.execute({
      sessionToken: new SecretString('session-token'),
      organizationId: ids[3]!,
      invitationId: ids[2]!,
      work: work(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('organization.invitation.accept_forbidden');
    expect(committed()).toBeUndefined();
  });
});
