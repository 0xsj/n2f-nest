import { failure, type Failure } from '../../../shared/errors/index.js';

const conflict = (message: string, type: string): Failure =>
  failure('conflict', message, { type });

/** Another operation changed the record after this operation read it. */
export const staleWrite = (): Failure =>
  conflict('record was changed by a concurrent operation', 'organization.stale_write');

export const organizationExists = (): Failure =>
  conflict('organization already exists', 'organization.already_exists');

export const slugTaken = (): Failure =>
  conflict('organization slug is already in use', 'organization.slug_taken');

export const ownerMembershipExists = (): Failure =>
  conflict('membership already exists', 'organization.membership_exists');

export const membershipExists = (): Failure =>
  conflict('identity is already a member', 'organization.membership.already_exists');

export const invitationExists = (): Failure =>
  conflict('invitation already exists', 'organization.invitation_exists');

export const pendingInvitationExists = (): Failure =>
  conflict('identity already has a pending invitation', 'organization.invitation.already_exists');

export const acceptanceConflict = (): Failure =>
  conflict('invitation is no longer pending', 'organization.invitation.acceptance_conflict');

export const acceptedMembershipExists = (): Failure =>
  conflict('identity is already a member', 'organization.invitation.membership_exists');

export const membershipNotFound = (): Failure =>
  failure('not_found', 'membership was not found', {
    type: 'organization.membership.not_found',
  });

export const invitationNotFound = (): Failure =>
  failure('not_found', 'invitation was not found', {
    type: 'organization.invitation.not_found',
  });

/** Constraint names, as PostgreSQL reports them in unique violations. */
export const CONSTRAINTS = Object.freeze({
  organizationPkey: 'n2f_organization_organizations_pkey',
  slug: 'n2f_organization_organizations_slug_key',
  membershipPkey: 'n2f_organization_memberships_pkey',
  // PostgreSQL truncated the generated name when the table was created.
  membershipIdentity: 'n2f_organization_membership_organization_id_identity_id_key',
  invitationPkey: 'n2f_organization_invitations_pkey',
  pendingInvitation: 'n2f_organization_invitations_pending_identity',
});
