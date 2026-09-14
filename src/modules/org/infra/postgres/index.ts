/** Organization PostgreSQL persistence; see CONTRACT.md. */
import { readFileSync } from 'node:fs';
import { err, failure, ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import { Database, type Migration } from '../../../../shared/postgres/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import { Invitation, Membership, Organization, type InvitationSnapshot, type InvitationStatus, type MembershipSnapshot, type Role } from '../../domain/index.js';
import type { AcceptInvitationInput, ChangeMembershipRoleInput, CreateOrganizationRecord, CreateOutcome, InvitationAcceptOutcome, InvitationCreateOutcome, InvitationRecord, InvitationStore, OrganizationMembership, OrganizationReader, OrganizationStore, RoleChangeOutcome } from '../../app/index.js';

export const migration = (version: number): Migration => ({
  version,
  sql: readFileSync(new URL('./migrations/0006_org.sql', import.meta.url), 'utf8'),
});
export const invitationMigration = (version: number): Migration => ({
  version,
  sql: readFileSync(new URL('./migrations/0007_org_membership_workflow.sql', import.meta.url), 'utf8'),
});

const rollback = () => failure('conflict', 'organization store outcome rolled back', { type: 'org.store_rollback' });
const invalidRecord = () => failure('invalid', 'invalid organization store record', { type: 'org.store_invalid_record' });

function validRecord(record: CreateOrganizationRecord): boolean {
  const organization = Organization.restore(record.organization);
  if (!organization.ok) return false;
  const owner = Membership.restore(record.owner);
  return owner.ok && owner.value.snapshot().organizationId === organization.value.snapshot().id && owner.value.snapshot().role === 'owner';
}

type InvitationRow = {
  id: string; organization_id: string; inviter_principal_id: string; invitee_principal_id: string;
  role: string; status: string; created_at_ms: string; expires_at_ms: string; resolved_at_ms: string | null;
};
const roleOf = (raw: string): Role | undefined => raw === 'owner' || raw === 'admin' || raw === 'member' ? raw : undefined;
const invitationRoleOf = (raw: string): Exclude<Role, 'owner'> | undefined => raw === 'admin' || raw === 'member' ? raw : undefined;
const statusOf = (raw: string): InvitationStatus | undefined => raw === 'pending' || raw === 'accepted' || raw === 'revoked' ? raw : undefined;
function invitationOf(row: InvitationRow): Result<InvitationSnapshot, Failure> {
  const role = invitationRoleOf(row.role), status = statusOf(row.status);
  if (!role || !status) return err(invalidRecord());
  const invitation = Invitation.restore({
    id: row.id as ID, organizationId: row.organization_id as ID, inviterPrincipalId: row.inviter_principal_id as ID,
    inviteePrincipalId: row.invitee_principal_id as ID, role, status,
    createdAtMs: Number(row.created_at_ms), expiresAtMs: Number(row.expires_at_ms),
    ...(row.resolved_at_ms === null ? {} : { resolvedAtMs: Number(row.resolved_at_ms) }),
  });
  return invitation.ok ? ok(invitation.value.snapshot()) : err(invalidRecord());
}
const validStoredID = (value: string): value is ID => parse(value).ok;

export class Store implements OrganizationReader, OrganizationStore, InvitationStore {
  constructor(readonly database: Database) {}

  async createOrganization(record: CreateOrganizationRecord): Promise<Result<CreateOutcome, Failure>> {
    if (!validRecord(record)) return err(invalidRecord());
    const result = await this.database.transaction(async (tx) => {
      const organization = await tx.query(
        'INSERT INTO public.n2f_org_organizations(id,name,created_at_ms) VALUES($1::uuid,$2,$3) ON CONFLICT(id) DO NOTHING',
        [record.organization.id, record.organization.name, record.organization.createdAtMs],
      );
      if (organization.rowCount !== 1) return err(rollback());
      const owner = await tx.query(
        'INSERT INTO public.n2f_org_memberships(id,organization_id,principal_id,role,created_at_ms) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5) ON CONFLICT(id) DO NOTHING',
        [record.owner.id, record.owner.organizationId, record.owner.principalId, record.owner.role, record.owner.createdAtMs],
      );
      if (owner.rowCount !== 1) return err(rollback());
      return ok('created' as const);
    });
    if (!result.ok && result.error.type === 'org.store_rollback') return ok('already_exists' as const);
    return result;
  }

  async listForPrincipal(principalId: string, limit: number): Promise<Result<OrganizationMembership[], Failure>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return err(invalidRecord());
    return this.database.transaction(async (tx) => {
      try {
        const rows = (await tx.query(
          `SELECT o.id AS organization_id,o.name,o.created_at_ms AS organization_created_at_ms,m.id AS membership_id,m.organization_id AS membership_organization_id,m.principal_id AS membership_principal_id,m.role,m.created_at_ms AS membership_created_at_ms
 FROM public.n2f_org_memberships m JOIN public.n2f_org_organizations o ON o.id=m.organization_id
 WHERE m.principal_id=$1::uuid ORDER BY o.created_at_ms DESC,o.id DESC LIMIT $2`,
          [principalId, limit],
        )).rows;
        const out: OrganizationMembership[] = [];
        for (const row of rows) {
          const organization = Organization.restore({
            id: row.organization_id,
            name: row.name,
            createdAtMs: Number(row.organization_created_at_ms),
          });
          if (!organization.ok) return err(invalidRecord());
          const membership = Membership.restore({
            id: row.membership_id,
            organizationId: row.membership_organization_id,
            principalId: row.membership_principal_id,
            role: row.role,
            createdAtMs: Number(row.membership_created_at_ms),
          });
          if (!membership.ok || membership.value.snapshot().organizationId !== organization.value.snapshot().id || membership.value.snapshot().principalId !== principalId)
            return err(invalidRecord());
          out.push({ organization: organization.value.snapshot(), membership: membership.value.snapshot() });
        }
        return ok(out);
      } catch (cause) {
        return err(failure('internal', 'organization read failed', { type: 'org.store_read_failed', cause }));
      }
    });
  }

  async createInvitation(record: InvitationRecord): Promise<Result<InvitationCreateOutcome, Failure>> {
    if (!Invitation.restore(record.invitation).ok) return err(invalidRecord());
    return this.database.transaction<InvitationCreateOutcome>(async (tx) => {
      const invitation = record.invitation;
      const actor = await tx.query<{ role: string }>('SELECT role FROM public.n2f_org_memberships WHERE organization_id=$1::uuid AND principal_id=$2::uuid FOR UPDATE', [invitation.organizationId, invitation.inviterPrincipalId]);
      const actorRole = actor.rowCount === 1 ? roleOf(actor.rows[0].role) : undefined;
      if (!actorRole || (actorRole !== 'owner' && actorRole !== 'admin') || (actorRole === 'admin' && invitation.role === 'admin')) return ok('unauthorized' as const);
      const member = await tx.query('SELECT 1 FROM public.n2f_org_memberships WHERE organization_id=$1::uuid AND principal_id=$2::uuid', [invitation.organizationId, invitation.inviteePrincipalId]);
      if (member.rowCount === 1) return ok('member_exists' as const);
      const inserted = await tx.query('INSERT INTO public.n2f_org_invitations(id,organization_id,inviter_principal_id,invitee_principal_id,role,status,created_at_ms,expires_at_ms,resolved_at_ms) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9) ON CONFLICT (organization_id,invitee_principal_id) WHERE status=\'pending\' DO NOTHING', [invitation.id, invitation.organizationId, invitation.inviterPrincipalId, invitation.inviteePrincipalId, invitation.role, invitation.status, invitation.createdAtMs, invitation.expiresAtMs, invitation.resolvedAtMs ?? null]);
      return ok(inserted.rowCount === 1 ? 'created' as const : 'already_exists' as const);
    });
  }

  async acceptInvitation(input: AcceptInvitationInput, nowMs: number, membershipId: ID): Promise<Result<Readonly<{ outcome: InvitationAcceptOutcome; invitation?: InvitationRecord; membership?: MembershipSnapshot }>, Failure>> {
    if (!validStoredID(input.invitationId) || !validStoredID(input.inviteeId) || !validStoredID(membershipId)) return err(invalidRecord());
    return this.database.transaction<Readonly<{ outcome: InvitationAcceptOutcome; invitation?: InvitationRecord; membership?: MembershipSnapshot }>>(async (tx) => {
      const result = await tx.query<InvitationRow>('SELECT id,organization_id,inviter_principal_id,invitee_principal_id,role,status,created_at_ms,expires_at_ms,resolved_at_ms FROM public.n2f_org_invitations WHERE id=$1::uuid FOR UPDATE', [input.invitationId]);
      if (result.rowCount !== 1) return ok({ outcome: 'not_found' as const });
      const restored = invitationOf(result.rows[0]);
      if (!restored.ok) return restored;
      const invitation = restored.value;
      if (invitation.inviteePrincipalId !== input.inviteeId) return ok({ outcome: 'not_for_principal' as const });
      if (invitation.status === 'accepted') return ok({ outcome: 'already_accepted' as const });
      if (invitation.status !== 'pending') return ok({ outcome: 'expired' as const });
      const domain = Invitation.restore(invitation);
      if (!domain.ok) return err(invalidRecord());
      if (nowMs >= invitation.expiresAtMs) {
        const revoked = domain.value.revoke(nowMs);
        if (!revoked.ok) return err(invalidRecord());
        await tx.query('UPDATE public.n2f_org_invitations SET status=\'revoked\',resolved_at_ms=$2 WHERE id=$1::uuid', [invitation.id, nowMs]);
        return ok({ outcome: 'expired' as const });
      }
      const member = await tx.query('SELECT 1 FROM public.n2f_org_memberships WHERE organization_id=$1::uuid AND principal_id=$2::uuid', [invitation.organizationId, invitation.inviteePrincipalId]);
      if (member.rowCount === 1) return ok({ outcome: 'member_exists' as const });
      const membership = Membership.create(membershipId, invitation.organizationId, invitation.inviteePrincipalId, invitation.role, nowMs);
      if (!membership.ok) return err(invalidRecord());
      const inserted = await tx.query('INSERT INTO public.n2f_org_memberships(id,organization_id,principal_id,role,created_at_ms) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5) ON CONFLICT (organization_id,principal_id) DO NOTHING', [membershipId, invitation.organizationId, invitation.inviteePrincipalId, invitation.role, nowMs]);
      if (inserted.rowCount !== 1) return ok({ outcome: 'member_exists' as const });
      const accepted = domain.value.accept(nowMs);
      if (!accepted.ok) return err(invalidRecord());
      await tx.query('UPDATE public.n2f_org_invitations SET status=\'accepted\',resolved_at_ms=$2 WHERE id=$1::uuid', [invitation.id, nowMs]);
      return ok({ outcome: 'accepted' as const, invitation: { invitation: accepted.value.snapshot() }, membership: membership.value.snapshot() });
    });
  }

  async changeMembershipRole(input: ChangeMembershipRoleInput): Promise<Result<Readonly<{ outcome: RoleChangeOutcome; membership?: MembershipSnapshot }>, Failure>> {
    if (!validStoredID(input.organizationId) || !validStoredID(input.actorId) || !validStoredID(input.targetId) || !roleOf(input.role) || input.role === 'owner') return err(invalidRecord());
    return this.database.transaction<Readonly<{ outcome: RoleChangeOutcome; membership?: MembershipSnapshot }>>(async (tx) => {
      const actor = await tx.query<{ role: string }>('SELECT role FROM public.n2f_org_memberships WHERE organization_id=$1::uuid AND principal_id=$2::uuid FOR UPDATE', [input.organizationId, input.actorId]);
      const actorRole = actor.rowCount === 1 ? roleOf(actor.rows[0].role) : undefined;
      if (!actorRole || (actorRole !== 'owner' && actorRole !== 'admin') || (actorRole === 'admin' && input.role === 'admin')) return ok({ outcome: 'unauthorized' as const });
      const target = await tx.query<{ id: string; organization_id: string; principal_id: string; role: string; created_at_ms: string }>('SELECT id,organization_id,principal_id,role,created_at_ms FROM public.n2f_org_memberships WHERE organization_id=$1::uuid AND principal_id=$2::uuid FOR UPDATE', [input.organizationId, input.targetId]);
      if (target.rowCount !== 1) return ok({ outcome: 'target_not_found' as const });
      const row = target.rows[0], targetRole = roleOf(row.role);
      if (!targetRole) return err(invalidRecord());
      if (targetRole === 'owner') return ok({ outcome: 'owner_target' as const });
      if (targetRole === input.role) return ok({ outcome: 'unchanged' as const });
      await tx.query('UPDATE public.n2f_org_memberships SET role=$2 WHERE id=$1::uuid', [row.id, input.role]);
      const id = parse(row.id), organizationId = parse(row.organization_id), principalId = parse(row.principal_id);
      if (!id.ok || !organizationId.ok || !principalId.ok) return err(invalidRecord());
      const membership = Membership.create(id.value, organizationId.value, principalId.value, input.role, Number(row.created_at_ms));
      return membership.ok ? ok({ outcome: 'changed' as const, membership: membership.value.snapshot() }) : err(invalidRecord());
    });
  }
}
