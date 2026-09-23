import { describe, expect, it } from 'vitest';
import { InMemoryEventBus } from '../../../platform/events/in-memory-event-bus.js';
import type { ID } from '../../../shared/id/index.js';
import {
  HOUR,
  event,
  newId,
  postgresContract,
  value,
  work,
} from '../../../../test/support/adapter-contract.js';
import type {
  InvitationAcceptanceWriter,
  InvitationReader,
  InvitationWriter,
  MembershipReader,
  MembershipWriter,
  OrganizationWriter,
} from '../app/ports/index.js';
import { Invitation, Membership, Organization } from '../domain/index.js';
import {
  InMemoryInvitationAcceptanceWriter,
  InMemoryInvitationReader,
  InMemoryInvitationWriter,
  InMemoryMembershipReader,
  InMemoryMembershipWriter,
  InMemoryOrganizationStore,
  InMemoryOrganizationWriter,
} from './in-memory/index.js';
import {
  PostgresInvitationAcceptanceWriter,
  PostgresInvitationReader,
  PostgresInvitationWriter,
  PostgresMembershipReader,
  PostgresMembershipWriter,
  PostgresOrganizationWriter,
} from './postgres/index.js';

/**
 * One behavioral contract for every Organization storage adapter, including
 * the concurrent-write races found in the 2026-09-23 review. The in-memory run
 * always executes; the PostgreSQL run needs a disposable database.
 */
type Adapters = Readonly<{
  organizations: OrganizationWriter;
  memberships: MembershipReader;
  membershipWriter: MembershipWriter;
  invitations: InvitationReader;
  invitationWriter: InvitationWriter;
  acceptance: InvitationAcceptanceWriter;
}>;

function slug(): string {
  return `c${newId().replace(/-/g, '').slice(-24)}`;
}

function contract(name: string, adapters: () => Adapters) {
  describe(`${name} Organization adapters`, () => {
    async function organization(withSlug = slug()) {
      const a = adapters();
      const createdAt = new Date(Date.now() - HOUR);
      const created = value(
        Organization.create({ id: newId(), name: 'Contract', slug: withSlug, createdAt }),
      );
      const owner = value(
        Membership.add({
          id: newId(),
          organizationId: created.id,
          identityId: newId(),
          role: 'owner',
          createdAt,
        }),
      );
      const context = work('organization.create');
      const result = await a.organizations.commit({
        organization: created,
        ownerMembership: owner,
        events: [event('organization.created.v1', context)],
        work: context,
      });
      return { organization: created, slug: withSlug, result };
    }

    async function member(organizationId: ID) {
      const a = adapters();
      const added = value(
        Membership.add({
          id: newId(),
          organizationId,
          identityId: newId(),
          role: 'member',
          createdAt: new Date(Date.now() - HOUR / 2),
        }),
      );
      const context = work('organization.membership.add');
      value(
        await a.membershipWriter.commit({
          membership: added,
          event: event('organization.membership.added.v1', context),
          work: context,
        }),
      );
      return value(await a.memberships.findById(added.id))!;
    }

    async function invitation(organizationId: ID) {
      const a = adapters();
      const createdAt = new Date(Date.now() - HOUR / 2);
      const issued = value(
        Invitation.issue({
          id: newId(),
          organizationId,
          identityId: newId(),
          role: 'member',
          createdAt,
          expiresAt: new Date(createdAt.getTime() + 24 * HOUR),
        }),
      );
      const context = work('organization.invitation.create');
      value(
        await a.invitationWriter.commit({
          invitation: issued,
          event: event('organization.invitation.created.v1', context),
          work: context,
        }),
      );
      return value(await a.invitations.findById(issued.id))!;
    }

    function saveMembership(membership: Membership) {
      const context = work('organization.membership.change');
      return adapters().membershipWriter.commit({
        membership,
        event: event('organization.membership.changed.v1', context),
        work: context,
      });
    }

    function accept(loaded: Invitation) {
      const at = new Date();
      const accepted = value(loaded.accept(at));
      const membership = value(
        Membership.add({
          id: newId(),
          organizationId: loaded.organizationId,
          identityId: loaded.identityId,
          role: loaded.role,
          createdAt: at,
        }),
      );
      const context = work('organization.invitation.accept');
      return adapters().acceptance.commit({
        invitation: accepted,
        membership,
        events: [
          event('organization.invitation.accepted.v1', context),
          event('organization.membership.added.v1', context),
        ],
        work: context,
      });
    }

    function revokeInvitation(loaded: Invitation) {
      const context = work('organization.invitation.revoke');
      return adapters().invitationWriter.commit({
        invitation: value(loaded.revoke(new Date())),
        event: event('organization.invitation.revoked.v1', context),
        work: context,
      });
    }

    it('reports a taken slug as organization.slug_taken', async () => {
      const first = await organization();
      expect(first.result.ok).toBe(true);

      const duplicate = await organization(first.slug);

      expect(duplicate.result).toMatchObject({
        ok: false,
        error: { kind: 'conflict', type: 'organization.slug_taken' },
      });
    });

    it('refuses a second membership for the same identity', async () => {
      const { organization: created } = await organization();
      const existing = await member(created.id);
      const context = work('organization.membership.add');

      const duplicate = await adapters().membershipWriter.commit({
        membership: value(
          Membership.add({
            id: newId(),
            organizationId: created.id,
            identityId: existing.identityId,
            role: 'admin',
            createdAt: new Date(),
          }),
        ),
        event: event('organization.membership.added.v1', context),
        work: context,
      });

      expect(duplicate).toMatchObject({
        ok: false,
        error: { kind: 'conflict', type: 'organization.membership.already_exists' },
      });
    });

    it('does not let a role change read before a revocation reactivate the member', async () => {
      const { organization: created } = await organization();
      const loaded = await member(created.id);
      const at = new Date();

      const revoked = await saveMembership(value(loaded.revoke(at)));
      const promoted = await saveMembership(value(loaded.changeRole('admin', at)));

      expect(revoked.ok).toBe(true);
      expect(promoted).toMatchObject({
        ok: false,
        error: { kind: 'conflict', type: 'organization.stale_write' },
      });
      const stored = value(await adapters().memberships.findById(loaded.id))!;
      expect(stored.status).toBe('revoked');
      expect(stored.role).toBe('member');
    });

    it('does not let a revocation read before an acceptance overwrite it', async () => {
      const { organization: created } = await organization();
      const loaded = await invitation(created.id);

      const accepted = await accept(loaded);
      const revoked = await revokeInvitation(loaded);

      expect(accepted.ok).toBe(true);
      expect(revoked).toMatchObject({
        ok: false,
        error: { kind: 'conflict', type: 'organization.stale_write' },
      });
      expect(value(await adapters().invitations.findById(loaded.id))!.status).toBe('accepted');
    });

    it('does not accept an invitation revoked after it was read', async () => {
      const { organization: created } = await organization();
      const loaded = await invitation(created.id);

      const revoked = await revokeInvitation(loaded);
      const accepted = await accept(loaded);

      expect(revoked.ok).toBe(true);
      expect(accepted).toMatchObject({
        ok: false,
        error: { kind: 'conflict', type: 'organization.invitation.acceptance_conflict' },
      });
      expect(
        value(await adapters().memberships.findForIdentity(created.id, loaded.identityId)),
      ).toBeNull();
    });

    it('creates exactly one membership when an invitation is accepted twice', async () => {
      const { organization: created } = await organization();
      const loaded = await invitation(created.id);

      const first = await accept(loaded);
      const second = await accept(loaded);

      expect(first.ok).toBe(true);
      expect(second).toMatchObject({
        ok: false,
        error: { kind: 'conflict', type: 'organization.invitation.acceptance_conflict' },
      });
      expect(
        value(await adapters().memberships.findForIdentity(created.id, loaded.identityId)),
      ).not.toBeNull();
    });
  });
}

let memory: Adapters | undefined;
contract('in-memory', () => {
  if (!memory) {
    const store = new InMemoryOrganizationStore();
    const bus = new InMemoryEventBus();
    memory = {
      organizations: new InMemoryOrganizationWriter(store, bus),
      memberships: new InMemoryMembershipReader(store),
      membershipWriter: new InMemoryMembershipWriter(store, bus),
      invitations: new InMemoryInvitationReader(store),
      invitationWriter: new InMemoryInvitationWriter(store, bus),
      acceptance: new InMemoryInvitationAcceptanceWriter(store, bus),
    };
  }
  return memory;
});

postgresContract(
  (database): Adapters => ({
    organizations: new PostgresOrganizationWriter(database),
    memberships: new PostgresMembershipReader(database),
    membershipWriter: new PostgresMembershipWriter(database),
    invitations: new PostgresInvitationReader(database),
    invitationWriter: new PostgresInvitationWriter(database),
    acceptance: new PostgresInvitationAcceptanceWriter(database),
  }),
  (adapters) => contract('PostgreSQL', adapters),
);
