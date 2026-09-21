import { describe, expect, it } from 'vitest';
import { ok } from '../../../../shared/errors/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import { Membership, Organization } from '../../domain/index.js';
import type {
  CurrentActorReader,
  OrganizationMembershipView,
  OrganizationReader,
} from '../ports/index.js';
import { ListCurrentOrganizations } from './list-current-organizations.js';

const ids = [
  '01900000-0000-7000-8000-000000000001',
  '01900000-0000-7000-8000-000000000002',
  '01900000-0000-7000-8000-000000000003',
].map((value) => parse(value));

if (ids.some((result) => !result.ok)) throw new Error('organization IDs invalid');

const validIds: ID[] = ids.map((result) => {
  if (!result.ok) throw new Error('organization ID invalid');
  return result.value;
});

function view(): OrganizationMembershipView {
  const organization = Organization.create({
    id: validIds[1]!,
    name: 'Signal Arts',
    slug: 'signal-arts',
    createdAt: new Date('2026-09-20T00:00:00.000Z'),
  });
  if (!organization.ok) throw new Error(organization.error.message);

  const membership = Membership.add({
    id: validIds[2]!,
    organizationId: organization.value.id,
    identityId: validIds[0]!,
    role: 'owner',
    createdAt: new Date('2026-09-20T00:00:00.000Z'),
  });
  if (!membership.ok) throw new Error(membership.error.message);

  return { organization: organization.value, membership: membership.value };
}

describe('ListCurrentOrganizations', () => {
  it('resolves the actor and returns organization membership views', async () => {
    const expected = [view()];
    let queriedIdentity: ID | undefined;
    const actors: CurrentActorReader = {
      findCurrent: async () => ok({ identityId: validIds[0]! }),
    };
    const organizations: OrganizationReader = {
      listForIdentity: async (identityId) => {
        queriedIdentity = identityId;
        return ok(expected);
      },
    };

    const result = await new ListCurrentOrganizations({ actors, organizations }).execute({
      sessionToken: new SecretString('session-token'),
    });

    expect(result).toEqual(ok(expected));
    expect(queriedIdentity).toBe(validIds[0]);
  });

  it('does not query organizations when the actor is unauthenticated', async () => {
    let queried = false;
    const actors: CurrentActorReader = {
      findCurrent: async () => ({
        ok: false as const,
        error: {
          kind: 'unauthenticated' as const,
          message: 'session is invalid',
        },
      }),
    };
    const organizations: OrganizationReader = {
      listForIdentity: async () => {
        queried = true;
        return ok([]);
      },
    };

    const result = await new ListCurrentOrganizations({ actors, organizations }).execute({
      sessionToken: new SecretString('invalid'),
    });

    expect(result.ok).toBe(false);
    expect(queried).toBe(false);
  });
});
