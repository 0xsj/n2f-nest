import { err, failure, ok, type Failure, type Result } from '../../../shared/errors/index.js';
import { parse, type ID } from '../../../shared/id/index.js';
import { text } from '../../../shared/validation/index.js';

const MAX_TIME_MS = 253402300799999;
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const invalidOrganization = () => failure('invalid', 'invalid organization', { type: 'org.organization_invalid' });
const invalidMembership = () => failure('invalid', 'invalid membership', { type: 'org.membership_invalid' });
const invalidRole = () => failure('invalid', 'invalid organization role', { type: 'org.role_invalid' });
const validName = (name: string) => text(name, 1, 100, true).ok && ![...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const validTime = (at: number) => Number.isSafeInteger(at) && at >= 0 && at <= MAX_TIME_MS;
const validID = (id: ID) => id !== ZERO_ID && parse(id).ok;

export type OrganizationSnapshot = Readonly<{ id: ID; name: string; createdAtMs: number }>;
export class Organization {
  readonly #state: OrganizationSnapshot;
  private constructor(state: OrganizationSnapshot) { this.#state = Object.freeze({ ...state }); }
  static create(id: ID, name: string, at: number): Result<Organization, Failure> {
    return Organization.restore({ id, name, createdAtMs: at });
  }
  static restore(state: OrganizationSnapshot): Result<Organization, Failure> {
    if (!state || !validID(state.id) || !validName(state.name) || !validTime(state.createdAtMs)) return err(invalidOrganization());
    const id = parse(state.id);
    return id.ok ? ok(new Organization({ ...state, id: id.value })) : err(invalidOrganization());
  }
  snapshot(): OrganizationSnapshot { return { ...this.#state }; }
}

export type Role = 'owner' | 'admin' | 'member';
const validRole = (role: string): role is Role => role === 'owner' || role === 'admin' || role === 'member';
export type MembershipSnapshot = Readonly<{ id: ID; organizationId: ID; principalId: ID; role: Role; createdAtMs: number }>;
export class Membership {
  readonly #state: MembershipSnapshot;
  private constructor(state: MembershipSnapshot) { this.#state = Object.freeze({ ...state }); }
  static create(id: ID, organizationId: ID, principalId: ID, role: Role, at: number): Result<Membership, Failure> {
    if (!validRole(role)) return err(invalidRole());
    const state = { id, organizationId, principalId, role, createdAtMs: at };
    if (!validID(id) || !validID(organizationId) || !validID(principalId) || !validTime(at)) return err(invalidMembership());
    return ok(new Membership(state));
  }
  static owner(id: ID, organizationId: ID, principalId: ID, at: number): Result<Membership, Failure> {
    return Membership.create(id, organizationId, principalId, 'owner', at);
  }
  static restore(state: MembershipSnapshot): Result<Membership, Failure> {
    return Membership.create(state.id, state.organizationId, state.principalId, state.role, state.createdAtMs);
  }
  snapshot(): MembershipSnapshot { return { ...this.#state }; }
}

export type InvitationStatus = 'pending' | 'accepted' | 'revoked';
export type InvitationSnapshot = Readonly<{
  id: ID;
  organizationId: ID;
  inviterPrincipalId: ID;
  inviteePrincipalId: ID;
  role: Exclude<Role, 'owner'>;
  status: InvitationStatus;
  createdAtMs: number;
  expiresAtMs: number;
  resolvedAtMs?: number;
}>;
const validInvitationRole = (role: Role): role is Exclude<Role, 'owner'> => role === 'admin' || role === 'member';
const validInvitationStatus = (status: InvitationStatus) => status === 'pending' || status === 'accepted' || status === 'revoked';
const invalidInvitation = () => failure('invalid', 'invalid organization invitation', { type: 'org.invitation_invalid' });
const invalidInvitationState = () => failure('invalid', 'invalid organization invitation state', { type: 'org.invitation_state_invalid' });
export class Invitation {
  readonly #state: InvitationSnapshot;
  private constructor(state: InvitationSnapshot) { this.#state = Object.freeze({ ...state }); }
  static create(id: ID, organizationId: ID, inviterPrincipalId: ID, inviteePrincipalId: ID, role: Role, createdAtMs: number, expiresAtMs: number): Result<Invitation, Failure> {
    return Invitation.restore({ id, organizationId, inviterPrincipalId, inviteePrincipalId, role: role as Exclude<Role, 'owner'>, status: 'pending', createdAtMs, expiresAtMs });
  }
  static restore(state: InvitationSnapshot): Result<Invitation, Failure> {
    if (!validInvitationRole(state.role)) return err(invalidRole());
    if (!validInvitationStatus(state.status) || !validID(state.id) || !validID(state.organizationId) || !validID(state.inviterPrincipalId) || !validID(state.inviteePrincipalId) || state.inviterPrincipalId === state.inviteePrincipalId || !validTime(state.createdAtMs) || !validTime(state.expiresAtMs) || state.expiresAtMs <= state.createdAtMs || (state.status === 'pending' ? state.resolvedAtMs !== undefined : state.resolvedAtMs === undefined || !validTime(state.resolvedAtMs))) return err(invalidInvitation());
    const id = parse(state.id);
    return id.ok ? ok(new Invitation({ ...state, id: id.value })) : err(invalidInvitation());
  }
  accept(at: number): Result<Invitation, Failure> {
    if (this.#state.status !== 'pending') return err(invalidInvitationState());
    if (at < this.#state.createdAtMs || at >= this.#state.expiresAtMs) return err(failure('conflict', 'organization invitation expired', { type: 'org.invitation_expired' }));
    return Invitation.restore({ ...this.#state, status: 'accepted', resolvedAtMs: at });
  }
  revoke(at: number): Result<Invitation, Failure> {
    if (this.#state.status !== 'pending') return err(invalidInvitationState());
    if (at < this.#state.createdAtMs || !validTime(at)) return err(invalidInvitation());
    return Invitation.restore({ ...this.#state, status: 'revoked', resolvedAtMs: at });
  }
  snapshot(): InvitationSnapshot { return { ...this.#state }; }
}
