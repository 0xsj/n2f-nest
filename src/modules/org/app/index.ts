import { err, failure, ok, type Failure, type Result } from '../../../shared/errors/index.js';
import type { ID } from '../../../shared/id/index.js';
import { parse } from '../../../shared/id/index.js';
import { Invitation, Membership, Organization, type InvitationSnapshot, type MembershipSnapshot, type OrganizationSnapshot, type Role } from '../domain/index.js';

export interface Clock { now(): Date }
export interface IDSource { newId(): Result<ID, Failure> }

/** Root translates identity's deliberate application surface into this org-owned result. */
export type Eligibility = Readonly<{ eligible: boolean }>;
export interface PrincipalEligibility {
  checkActive(principalId: ID): Promise<Result<Eligibility, Failure>>;
}
export type CreateOrganizationRecord = Readonly<{
  organization: OrganizationSnapshot;
  owner: MembershipSnapshot;
}>;
export type CreateOutcome = 'created' | 'already_exists';
export interface OrganizationStore {
  /** The adapter owns the transaction containing the organization and owner. */
  createOrganization(record: CreateOrganizationRecord): Promise<Result<CreateOutcome, Failure>>;
}
export type OrganizationMembership = Readonly<{
  organization: OrganizationSnapshot;
  membership: MembershipSnapshot;
}>;
export interface OrganizationReader {
  /** Returns only organizations where the principal has a membership. */
  listForPrincipal(principalId: ID, limit: number): Promise<Result<OrganizationMembership[], Failure>>;
}
export type InvitationRecord = Readonly<{ invitation: InvitationSnapshot }>;
export type InvitationCreateOutcome = 'created' | 'already_exists' | 'member_exists' | 'unauthorized';
export type InvitationAcceptOutcome = 'accepted' | 'already_accepted' | 'expired' | 'not_found' | 'not_for_principal' | 'member_exists';
export type RoleChangeOutcome = 'changed' | 'unchanged' | 'target_not_found' | 'unauthorized' | 'owner_target';
export type AcceptInvitationInput = Readonly<{ invitationId: ID; inviteeId: ID }>;
export type ChangeMembershipRoleInput = Readonly<{ organizationId: ID; actorId: ID; targetId: ID; role: Role }>;
export interface InvitationStore {
  createInvitation(record: InvitationRecord): Promise<Result<InvitationCreateOutcome, Failure>>;
  acceptInvitation(input: AcceptInvitationInput, nowMs: number, membershipId: ID): Promise<Result<Readonly<{ outcome: InvitationAcceptOutcome; invitation?: InvitationRecord; membership?: MembershipSnapshot }>, Failure>>;
  changeMembershipRole(input: ChangeMembershipRoleInput): Promise<Result<Readonly<{ outcome: RoleChangeOutcome; membership?: MembershipSnapshot }>, Failure>>;
}
export type CreateOrganizationPorts = Readonly<{
  clock: Clock;
  ids: IDSource;
  eligibility: PrincipalEligibility;
  store: OrganizationStore;
}>;
export type CreateOrganizationInput = Readonly<{ name: string; ownerPrincipalId: ID }>;
export type CreateOrganizationResult = Readonly<{
  organization: OrganizationSnapshot;
  owner: MembershipSnapshot;
}>;
export type AcceptInvitationResult = Readonly<{
  invitation: InvitationSnapshot;
  membership: MembershipSnapshot;
}>;
export type ChangeMembershipRoleResult = Readonly<{ membership: MembershipSnapshot }>;

const invalidListInput = () => failure('invalid', 'invalid organization list input', { type: 'org.list_invalid' });

const invalidConfiguration = () => failure('invalid', 'invalid organization application configuration', { type: 'org.application_configuration' });
const invalidInput = () => failure('invalid', 'invalid organization creation input', { type: 'org.create_invalid' });
const ineligible = () => failure('forbidden', 'organization owner is not eligible', { type: 'org.principal_ineligible' });
const dependencyFailed = (cause?: unknown) => failure('unavailable', 'organization creation dependency failed', { type: 'org.create_dependency_failed', cause });
const exists = () => failure('conflict', 'organization already exists', { type: 'org.organization_exists' });
const validTime = (at: number) => Number.isSafeInteger(at) && at >= 0 && at <= 253402300799999;
const membershipConfiguration = () => failure('invalid', 'invalid organization membership configuration', { type: 'org.membership_configuration' });
const membershipInvalidInput = () => failure('invalid', 'invalid organization membership input', { type: 'org.membership_invalid_input' });
const inviteeIneligible = () => failure('forbidden', 'organization invitee is not eligible', { type: 'org.invitee_ineligible' });
const invitationExists = () => failure('conflict', 'organization invitation already exists', { type: 'org.invitation_exists' });
const memberExists = () => failure('conflict', 'organization member already exists', { type: 'org.member_exists' });
const membershipForbidden = () => failure('forbidden', 'organization membership action is not permitted', { type: 'org.membership_forbidden' });
const invitationNotFound = () => failure('not_found', 'organization invitation not found', { type: 'org.invitation_not_found' });
const invitationPrincipalMismatch = () => failure('forbidden', 'organization invitation is not for this principal', { type: 'org.invitation_principal_mismatch' });
const invitationExpired = () => failure('conflict', 'organization invitation expired', { type: 'org.invitation_expired' });
const invitationAlreadyAccepted = () => failure('conflict', 'organization invitation already accepted', { type: 'org.invitation_already_accepted' });
const roleUnchanged = () => failure('conflict', 'organization membership role is unchanged', { type: 'org.role_unchanged' });
const membershipNotFound = () => failure('not_found', 'organization membership not found', { type: 'org.membership_not_found' });
const roleTransitionInvalid = () => failure('invalid', 'invalid organization role transition', { type: 'org.role_transition_invalid' });
const membershipDependency = (cause?: unknown) => failure('unavailable', 'organization membership dependency failed', { type: 'org.membership_dependency_failed', cause });

export class CreateOrganization {
  readonly #ports: CreateOrganizationPorts;
  private constructor(ports: CreateOrganizationPorts) { this.#ports = ports; Object.freeze(this); }
  static create(ports: CreateOrganizationPorts): Result<CreateOrganization, Failure> {
    if (!ports?.clock || !ports.ids || !ports.eligibility || !ports.store) return err(invalidConfiguration());
    return ok(new CreateOrganization(ports));
  }
  async execute(input: CreateOrganizationInput): Promise<Result<CreateOrganizationResult, Failure>> {
    if (!input) return err(invalidInput());
    const owner = parse(input.ownerPrincipalId);
    if (!owner.ok) return err(invalidInput());
    const check = await this.#ports.eligibility.checkActive(owner.value);
    if (!check.ok) return check;
    if (!check.value.eligible) return err(ineligible());
    const now = this.#ports.clock.now().getTime();
    if (!validTime(now)) return err(dependencyFailed());
    const organizationId = this.#ports.ids.newId();
    if (!organizationId.ok) return err(dependencyFailed(organizationId.error));
    const membershipId = this.#ports.ids.newId();
    if (!membershipId.ok) return err(dependencyFailed(membershipId.error));
    const organization = Organization.create(organizationId.value, input.name, now);
    if (!organization.ok) return organization;
    const membership = Membership.owner(membershipId.value, organizationId.value, owner.value, now);
    if (!membership.ok) return membership;
    const record = { organization: organization.value.snapshot(), owner: membership.value.snapshot() } satisfies CreateOrganizationRecord;
    const stored = await this.#ports.store.createOrganization(record);
    if (!stored.ok) return stored;
    return stored.value === 'already_exists' ? err(exists()) : ok(record);
  }
}

export class ListOrganizations {
  private constructor(private readonly reader: OrganizationReader) { Object.freeze(this); }
  static create(reader: OrganizationReader): Result<ListOrganizations, Failure> {
    return reader ? ok(new ListOrganizations(reader)) : err(invalidConfiguration());
  }
  async execute(principalId: ID, limit: number): Promise<Result<OrganizationMembership[], Failure>> {
    const principal = parse(principalId);
    if (!principal.ok || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return err(invalidListInput());
    return this.reader.listForPrincipal(principal.value, limit);
  }
}

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const inviteRole = (role: Role): role is Exclude<Role, 'owner'> => role === 'admin' || role === 'member';
const nowMs = (clock: Clock): Result<number, Failure> => {
  const value = clock.now().getTime();
  return validTime(value) ? ok(value) : err(membershipDependency());
};

export class InviteMember {
  private constructor(private readonly ports: CreateOrganizationPorts) { Object.freeze(this); }
  static create(ports: CreateOrganizationPorts): Result<InviteMember, Failure> {
    return ports?.clock && ports.ids && ports.eligibility && ports.store && 'createInvitation' in ports.store
      ? ok(new InviteMember(ports)) : err(membershipConfiguration());
  }
  async execute(input: Readonly<{ organizationId: ID; inviterId: ID; inviteeId: ID; role: Role }>): Promise<Result<Readonly<{ invitation: InvitationSnapshot }>, Failure>> {
    if (!input) return err(membershipInvalidInput());
    const organization = parse(input.organizationId), inviter = parse(input.inviterId), invitee = parse(input.inviteeId);
    if (!organization.ok || !inviter.ok || !invitee.ok || inviter.value === invitee.value || !inviteRole(input.role)) return err(membershipInvalidInput());
    const eligible = await this.ports.eligibility.checkActive(invitee.value);
    if (!eligible.ok) return eligible;
    if (!eligible.value.eligible) return err(inviteeIneligible());
    const now = nowMs(this.ports.clock);
    if (!now.ok) return now;
    const expires = now.value + INVITATION_TTL_MS;
    if (!validTime(expires)) return err(membershipDependency());
    const id = this.ports.ids.newId();
    if (!id.ok) return err(membershipDependency(id.error));
    const invitation = Invitation.create(id.value, organization.value, inviter.value, invitee.value, input.role, now.value, expires);
    if (!invitation.ok) return invitation;
    const stored = await (this.ports.store as unknown as InvitationStore).createInvitation({ invitation: invitation.value.snapshot() });
    if (!stored.ok) return stored;
    switch (stored.value) {
      case 'created': return ok({ invitation: invitation.value.snapshot() });
      case 'already_exists': return err(invitationExists());
      case 'member_exists': return err(memberExists());
      case 'unauthorized': return err(membershipForbidden());
    }
    return err(membershipDependency());
  }
}

export class AcceptInvitation {
  private constructor(private readonly ports: CreateOrganizationPorts) { Object.freeze(this); }
  static create(ports: CreateOrganizationPorts): Result<AcceptInvitation, Failure> {
    return ports?.clock && ports.ids && ports.store && 'acceptInvitation' in ports.store
      ? ok(new AcceptInvitation(ports)) : err(membershipConfiguration());
  }
  async execute(input: AcceptInvitationInput): Promise<Result<AcceptInvitationResult, Failure>> {
    const invitation = parse(input?.invitationId), invitee = parse(input?.inviteeId);
    if (!invitation.ok || !invitee.ok) return err(membershipInvalidInput());
    const now = nowMs(this.ports.clock);
    if (!now.ok) return now;
    const membershipId = this.ports.ids.newId();
    if (!membershipId.ok) return err(membershipDependency(membershipId.error));
    const stored = await (this.ports.store as unknown as InvitationStore).acceptInvitation({ invitationId: invitation.value, inviteeId: invitee.value }, now.value, membershipId.value);
    if (!stored.ok) return stored;
    if (stored.value.outcome === 'accepted' && stored.value.invitation && stored.value.membership) return ok({ invitation: stored.value.invitation.invitation, membership: stored.value.membership });
    switch (stored.value.outcome) {
      case 'already_accepted': return err(invitationAlreadyAccepted());
      case 'expired': return err(invitationExpired());
      case 'not_found': return err(invitationNotFound());
      case 'not_for_principal': return err(invitationPrincipalMismatch());
      case 'member_exists': return err(memberExists());
    }
    return err(membershipDependency());
  }
}

export class ChangeMembershipRole {
  private constructor(private readonly store: InvitationStore) { Object.freeze(this); }
  static create(store: InvitationStore): Result<ChangeMembershipRole, Failure> {
    return store ? ok(new ChangeMembershipRole(store)) : err(membershipConfiguration());
  }
  async execute(input: ChangeMembershipRoleInput): Promise<Result<ChangeMembershipRoleResult, Failure>> {
    const organization = parse(input?.organizationId), actor = parse(input?.actorId), target = parse(input?.targetId);
    if (!organization.ok || !actor.ok || !target.ok || actor.value === target.value || !inviteRole(input.role)) return err(roleTransitionInvalid());
    const result = await this.store.changeMembershipRole({ organizationId: organization.value, actorId: actor.value, targetId: target.value, role: input.role });
    if (!result.ok) return result;
    switch (result.value.outcome) {
      case 'changed': return result.value.membership ? ok({ membership: result.value.membership }) : err(membershipDependency());
      case 'unchanged': return err(roleUnchanged());
      case 'target_not_found': return err(membershipNotFound());
      case 'unauthorized': return err(membershipForbidden());
      case 'owner_target': return err(roleTransitionInvalid());
    }
    return err(membershipDependency());
  }
}
