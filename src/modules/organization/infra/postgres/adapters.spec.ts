import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import {
  anonymous,
  attribution,
  operation,
  restoreWork,
} from '../../../../shared/provenance/index.js';
import type { TransactionDatabase } from '../../../../shared/postgres/index.js';
import {
  Invitation,
  Membership,
  Organization,
} from '../../domain/index.js';
import { PostgresInvitationReader } from './invitation-reader.js';
import { PostgresMembershipReader } from './membership-reader.js';
import { PostgresOrganizationReader } from './reader.js';
import { PostgresOrganizationWriter } from './writer.js';

function id(value: string): ID {
  const result = parse(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function work(workId = id('00000000-0000-7000-8000-000000000071')) {
  const result = restoreWork({
    workId,
    correlationId: id('00000000-0000-7000-8000-000000000072'),
    correlationSource: 'local',
    operation: operation('organization.create').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'request',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function organizationFixture() {
  const result = Organization.create({
    id: id('00000000-0000-7000-8000-000000000073'),
    name: 'Postgres Contract Organization',
    slug: 'postgres-contract-organization',
    createdAt: new Date('2026-09-22T00:00:00.000Z'),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function ownerFixture(organizationId: ID) {
  const result = Membership.add({
    id: id('00000000-0000-7000-8000-000000000074'),
    organizationId,
    identityId: id('00000000-0000-7000-8000-000000000075'),
    role: 'owner',
    createdAt: new Date('2026-09-22T00:00:00.000Z'),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function events(organization: Organization, owner: Membership, context = work()) {
  const created = Envelope.create(
    id('00000000-0000-7000-8000-000000000076'),
    'organization.created.v1',
    organization.createdAt.getTime(),
    context,
    { organization_id: organization.id, identity_id: owner.identityId },
  );
  const membershipAdded = Envelope.create(
    id('00000000-0000-7000-8000-000000000077'),
    'organization.membership.added.v1',
    organization.createdAt.getTime(),
    context,
    { organization_id: organization.id, membership_id: owner.id },
  );
  if (!created.ok) throw new Error(created.error.message);
  if (!membershipAdded.ok) throw new Error(membershipAdded.error.message);
  return [created.value, membershipAdded.value] as const;
}

type Query = { readonly text: string; readonly values?: readonly unknown[] };

class QueryClient {
  readonly queries: Query[] = [];

  constructor(private readonly rows: readonly unknown[] = []) {}

  async query<T>(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, values });
    return { rowCount: 1, rows: this.rows as T[] };
  }
}

class DatabaseSpy implements TransactionDatabase {
  readonly client: QueryClient;

  constructor(rows: readonly unknown[] = []) {
    this.client = new QueryClient(rows);
  }

  transaction<T>(
    fn: (
      transaction: pg.PoolClient,
      signal: AbortSignal,
    ) => Promise<Result<T, Failure>>,
  ): Promise<Result<T, Failure>> {
    return fn(
      this.client as unknown as pg.PoolClient,
      new AbortController().signal,
    );
  }
}

describe('Organization PostgreSQL adapter contract', () => {
  it('writes organization state before enqueueing both facts', async () => {
    const database = new DatabaseSpy();
    const organization = organizationFixture();
    const owner = ownerFixture(organization.id);
    const context = work();
    const result = await new PostgresOrganizationWriter(database).commit({
      organization,
      ownerMembership: owner,
      events: events(organization, owner, context),
      work: context,
    });

    expect(result).toEqual(ok(undefined));
    expect(database.client.queries).toHaveLength(4);
    expect(database.client.queries[0]?.text).toContain(
      'n2f_organization_organizations',
    );
    expect(database.client.queries[1]?.text).toContain(
      'n2f_organization_memberships',
    );
    expect(database.client.queries[2]?.text).toContain('n2f_outbox');
    expect(database.client.queries[3]?.text).toContain('n2f_outbox');
  });

  it('rejects a multi-event write when provenance does not match', async () => {
    const database = new DatabaseSpy();
    const organization = organizationFixture();
    const owner = ownerFixture(organization.id);
    const eventWork = work();
    const result = await new PostgresOrganizationWriter(database).commit({
      organization,
      ownerMembership: owner,
      events: events(organization, owner, eventWork),
      work: work(id('00000000-0000-7000-8000-000000000078')),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('events.provenance_mismatch');
    expect(database.client.queries).toHaveLength(0);
  });

  it('rehydrates organization membership views through both aggregates', async () => {
    const organization = organizationFixture();
    const owner = ownerFixture(organization.id);
    const database = new DatabaseSpy([
      {
        organization_id: organization.id,
        organization_name: organization.name,
        organization_slug: organization.slug,
        organization_status: organization.status,
        organization_created_at: organization.createdAt,
        organization_updated_at: organization.updatedAt,
        organization_version: 1,
        membership_id: owner.id,
        membership_identity_id: owner.identityId,
        membership_role: owner.role,
        membership_status: owner.status,
        membership_created_at: owner.createdAt,
        membership_updated_at: owner.updatedAt,
        membership_revoked_at: owner.revokedAt,
        membership_version: 1,
      },
    ]);

    const result = await new PostgresOrganizationReader(database).listForIdentity(
      owner.identityId,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.organization.slug).toBe(
        'postgres-contract-organization',
      );
      expect(result.value[0]?.membership.role).toBe('owner');
    }
  });

  it('rehydrates memberships and pending invitations through their ports', async () => {
    const organizationId = id('00000000-0000-7000-8000-000000000079');
    const identityId = id('00000000-0000-7000-8000-000000000080');
    const createdAt = new Date('2026-09-22T00:00:00.000Z');
    const membership = Membership.add({
      id: id('00000000-0000-7000-8000-000000000081'),
      organizationId,
      identityId,
      role: 'member',
      createdAt,
    });
    const invitation = Invitation.issue({
      id: id('00000000-0000-7000-8000-000000000082'),
      organizationId,
      identityId,
      role: 'member',
      createdAt,
      expiresAt: new Date('2026-09-29T00:00:00.000Z'),
    });
    if (!membership.ok) throw new Error(membership.error.message);
    if (!invitation.ok) throw new Error(invitation.error.message);

    const membershipDatabase = new DatabaseSpy([
      {
        id: membership.value.id,
        organization_id: organizationId,
        identity_id: identityId,
        role: membership.value.role,
        status: membership.value.status,
        created_at: membership.value.createdAt,
        updated_at: membership.value.updatedAt,
        revoked_at: membership.value.revokedAt,
        version: 1,
      },
    ]);
    const invitationDatabase = new DatabaseSpy([
      {
        id: invitation.value.id,
        organization_id: organizationId,
        identity_id: identityId,
        role: invitation.value.role,
        status: invitation.value.status,
        created_at: invitation.value.createdAt,
        updated_at: invitation.value.updatedAt,
        expires_at: invitation.value.expiresAt,
        accepted_at: invitation.value.acceptedAt,
        revoked_at: invitation.value.revokedAt,
        version: 1,
      },
    ]);

    const restoredMembership = await new PostgresMembershipReader(
      membershipDatabase,
    ).findActiveForIdentity(organizationId, identityId);
    const restoredInvitation = await new PostgresInvitationReader(
      invitationDatabase,
    ).findPendingForIdentity(organizationId, identityId);

    expect(restoredMembership.ok).toBe(true);
    expect(restoredInvitation.ok).toBe(true);
    if (restoredMembership.ok) {
      expect(restoredMembership.value?.id).toBe(membership.value.id);
      expect(restoredMembership.value?.role).toBe('member');
    }
    if (restoredInvitation.ok) {
      expect(restoredInvitation.value?.id).toBe(invitation.value.id);
      expect(restoredInvitation.value?.status).toBe('pending');
    }
  });

  it('maps database failures to safe Result values', async () => {
    const database: TransactionDatabase = {
      transaction: async (fn) =>
        fn(
          {
            query: async () => {
              throw new Error('connection details must not escape');
            },
          } as unknown as pg.PoolClient,
          new AbortController().signal,
        ),
    };

    const result = await new PostgresOrganizationReader(database).listForIdentity(
      id('00000000-0000-7000-8000-000000000075'),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('unavailable');
  });
});
