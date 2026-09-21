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
import type { OrganizationWriter, CurrentActorReader } from '../ports/index.js';
import { CreateOrganization } from './create-organization.js';

const ids = [
  '01900000-0000-7000-8000-000000000001',
  '01900000-0000-7000-8000-000000000002',
  '01900000-0000-7000-8000-000000000003',
  '01900000-0000-7000-8000-000000000004',
  '01900000-0000-7000-8000-000000000005',
  '01900000-0000-7000-8000-000000000006',
].map((value) => parse(value));
if (ids.some((value) => !value.ok)) throw new Error('organization IDs invalid');

const values: ID[] = ids.map((value) => {
  if (!value.ok) throw new Error('organization ID invalid');
  return value.value;
});

function work() {
  const result = restoreWork({
    workId: values[0]!,
    correlationId: values[1]!,
    correlationSource: 'local',
    operation: operation('organization.create').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'request',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

class FixedIds implements IDGenerator {
  private readonly sequence = new Sequence(values.slice(2));

  newId(): Result<ID, Failure> {
    return this.sequence.newId();
  }
}

describe('CreateOrganization', () => {
  it('creates an organization and owner membership as one writer commit', async () => {
    let received: Parameters<OrganizationWriter['commit']>[0] | undefined;
    const actors: CurrentActorReader = {
      findCurrent: async () => ok({ identityId: values[0]! }),
    };
    const writer: OrganizationWriter = {
      commit: async (input) => {
        received = input;
        return ok(undefined);
      },
    };

    const result = await new CreateOrganization({
      clock: new FakeClock(new Date('2026-09-20T00:00:00.000Z')),
      ids: new FixedIds(),
      actors,
      writer,
    }).execute({
      sessionToken: new SecretString('session-token'),
      name: 'Signal Arts',
      slug: 'signal-arts',
      work: work(),
    });

    expect(result).toEqual(
      ok({
        organizationId: values[2],
        ownerMembershipId: values[3],
      }),
    );
    expect(received?.organization.id).toBe(values[2]);
    expect(received?.ownerMembership.identityId).toBe(values[0]);
    expect(received?.ownerMembership.role).toBe('owner');
    expect(received?.events.map((event) => event.type)).toEqual([
      'organization.created.v1',
      'organization.membership.added.v1',
    ]);
  });

  it('does not write when the authenticated actor cannot be resolved', async () => {
    let called = false;
    const result = await new CreateOrganization({
      clock: new FakeClock(new Date('2026-09-20T00:00:00.000Z')),
      ids: new FixedIds(),
      actors: {
        findCurrent: async () => ({
          ok: false as const,
          error: {
            kind: 'unauthenticated' as const,
            message: 'session is invalid',
          },
        }),
      },
      writer: {
        commit: async () => {
          called = true;
          return ok(undefined);
        },
      },
    }).execute({
      sessionToken: new SecretString('invalid'),
      name: 'Signal Arts',
      slug: 'signal-arts',
      work: work(),
    });

    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('rejects a command with the wrong provenance operation', async () => {
    const wrongWork = restoreWork({
      workId: values[0]!,
      correlationId: values[1]!,
      correlationSource: 'local',
      operation: operation('identity.register').value,
      attribution: attribution({ initiator: anonymous() }).value,
      origin: 'request',
    });
    if (!wrongWork.ok) throw new Error(wrongWork.error.message);

    const result = await new CreateOrganization({
      clock: new FakeClock(new Date('2026-09-20T00:00:00.000Z')),
      ids: new FixedIds(),
      actors: { findCurrent: async () => ok({ identityId: values[0]! }) },
      writer: { commit: async () => ok(undefined) },
    }).execute({
      sessionToken: new SecretString('session-token'),
      name: 'Signal Arts',
      slug: 'signal-arts',
      work: wrongWork.value,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('organization.invalid_operation');
  });
});
