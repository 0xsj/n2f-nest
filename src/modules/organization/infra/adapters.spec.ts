import { describe, expect, it } from 'vitest';
import { InMemoryEventBus } from '../../../platform/events/in-memory-event-bus.js';
import { err, failure, ok } from '../../../shared/errors/index.js';
import { Envelope } from '../../../shared/events/index.js';
import { parse, type ID } from '../../../shared/id/index.js';
import {
  anonymous,
  attribution,
  operation,
  restoreWork,
} from '../../../shared/provenance/index.js';
import {
  Invitation,
  Membership,
  Organization,
} from '../domain/index.js';
import { InMemoryInvitationAcceptanceWriter } from './in-memory/invitation-acceptance-writer.js';
import { InMemoryInvitationReader } from './in-memory/invitation-reader.js';
import { InMemoryMembershipReader } from './in-memory/membership-reader.js';
import { InMemoryOrganizationReader } from './in-memory/reader.js';
import { InMemoryOrganizationStore } from './in-memory/store.js';
import { InMemoryOrganizationWriter } from './in-memory/writer.js';

function id(value: string): ID {
  const result = parse(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function work(
  name: 'organization.create' | 'organization.invitation.accept',
  workId: ID,
) {
  const result = restoreWork({
    workId,
    correlationId: id('00000000-0000-7000-8000-000000000042'),
    correlationSource: 'local',
    operation: operation(name).value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'request',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function organizationFixture() {
  const result = Organization.create({
    id: id('00000000-0000-7000-8000-000000000043'),
    name: 'Adapter Contract Organization',
    slug: 'adapter-contract-organization',
    createdAt: new Date('2026-09-22T00:00:00.000Z'),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function ownerFixture(organizationId: ID) {
  const result = Membership.add({
    id: id('00000000-0000-7000-8000-000000000044'),
    organizationId,
    identityId: id('00000000-0000-7000-8000-000000000045'),
    role: 'owner',
    createdAt: new Date('2026-09-22T00:00:00.000Z'),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function organizationEvents(
  organization: Organization,
  owner: Membership,
  context = work(
    'organization.create',
    id('00000000-0000-7000-8000-000000000041'),
  ),
) {
  const created = Envelope.create(
    id('00000000-0000-7000-8000-000000000046'),
    'organization.created.v1',
    organization.createdAt.getTime(),
    context,
    { organization_id: organization.id, identity_id: owner.identityId },
  );
  const membershipAdded = Envelope.create(
    id('00000000-0000-7000-8000-000000000047'),
    'organization.membership.added.v1',
    organization.createdAt.getTime(),
    context,
    { organization_id: organization.id, membership_id: owner.id },
  );
  if (!created.ok) throw new Error(created.error.message);
  if (!membershipAdded.ok) throw new Error(membershipAdded.error.message);
  return [created.value, membershipAdded.value] as const;
}

describe('Organization in-memory adapter contract', () => {
  it('writes organization state, publishes both facts and reads the membership view', async () => {
    const store = new InMemoryOrganizationStore();
    const bus = new InMemoryEventBus();
    const published: ID[] = [];
    bus.subscribe(async (event) => {
      published.push(event.id);
      return ok(undefined);
    });

    const organization = organizationFixture();
    const owner = ownerFixture(organization.id);
    const context = work(
      'organization.create',
      id('00000000-0000-7000-8000-000000000041'),
    );
    const writer = new InMemoryOrganizationWriter(store, bus);
    const reader = new InMemoryOrganizationReader(store);
    const result = await writer.commit({
      organization,
      ownerMembership: owner,
      events: organizationEvents(organization, owner, context),
      work: context,
    });

    expect(result).toEqual(ok(undefined));
    expect(published).toHaveLength(2);

    const views = await reader.listForIdentity(owner.identityId);
    expect(views.ok).toBe(true);
    if (views.ok) {
      expect(views.value).toHaveLength(1);
      expect(views.value[0]?.organization.slug).toBe(
        'adapter-contract-organization',
      );
      expect(views.value[0]?.membership.role).toBe('owner');
    }
  });

  it('rolls back the organization pair when a later event publication fails', async () => {
    const store = new InMemoryOrganizationStore();
    const bus = new InMemoryEventBus();
    let publications = 0;
    bus.subscribe(async () => {
      publications += 1;
      return publications === 2
        ? err(
            failure('unavailable', 'test publisher unavailable', {
              type: 'test.publisher',
            }),
          )
        : ok(undefined);
    });
    const organization = organizationFixture();
    const owner = ownerFixture(organization.id);
    const context = work(
      'organization.create',
      id('00000000-0000-7000-8000-000000000041'),
    );
    const writer = new InMemoryOrganizationWriter(store, bus);

    const result = await writer.commit({
      organization,
      ownerMembership: owner,
      events: organizationEvents(organization, owner, context),
      work: context,
    });

    expect(result.ok).toBe(false);
    expect(store.organizationById(organization.id)).toBeUndefined();
    expect(store.membershipById(owner.id)).toBeUndefined();
  });

  it('commits invitation acceptance as one invitation and membership boundary', async () => {
    const store = new InMemoryOrganizationStore();
    const bus = new InMemoryEventBus();
    const organizationId = id('00000000-0000-7000-8000-000000000048');
    const identityId = id('00000000-0000-7000-8000-000000000049');
    const createdAt = new Date('2026-09-22T00:00:00.000Z');
    const issued = Invitation.issue({
      id: id('00000000-0000-7000-8000-000000000050'),
      organizationId,
      identityId,
      role: 'member',
      createdAt,
      expiresAt: new Date('2026-09-29T00:00:00.000Z'),
    });
    if (!issued.ok) throw new Error(issued.error.message);
    const accepted = issued.value.accept(new Date('2026-09-23T00:00:00.000Z'));
    if (!accepted.ok) throw new Error(accepted.error.message);
    const membership = Membership.add({
      id: id('00000000-0000-7000-8000-000000000051'),
      organizationId,
      identityId,
      role: 'member',
      createdAt: new Date('2026-09-23T00:00:00.000Z'),
    });
    if (!membership.ok) throw new Error(membership.error.message);

    store.addInvitation(issued.value);
    const context = work(
      'organization.invitation.accept',
      id('00000000-0000-7000-8000-000000000052'),
    );
    const events = [
      Envelope.create(
        id('00000000-0000-7000-8000-000000000053'),
        'organization.invitation.accepted.v1',
        accepted.value.updatedAt.getTime(),
        context,
        { invitation_id: accepted.value.id },
      ),
      Envelope.create(
        id('00000000-0000-7000-8000-000000000054'),
        'organization.membership.added.v1',
        membership.value.createdAt.getTime(),
        context,
        { membership_id: membership.value.id },
      ),
    ];
    if (events.some((event) => !event.ok)) throw new Error('invalid test event');

    const writer = new InMemoryInvitationAcceptanceWriter(store, bus);
    const result = await writer.commit({
      invitation: accepted.value,
      membership: membership.value,
      events: events.map((event) => {
        if (!event.ok) throw new Error(event.error.message);
        return event.value;
      }),
      work: context,
    });

    expect(result).toEqual(ok(undefined));
    expect((await new InMemoryInvitationReader(store).findById(accepted.value.id))).toEqual(
      ok(accepted.value),
    );
    expect((await new InMemoryMembershipReader(store).findById(membership.value.id))).toEqual(
      ok(membership.value),
    );
  });
});
