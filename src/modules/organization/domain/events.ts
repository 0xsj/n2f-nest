/** Event names owned by the Organization bounded context. */
export const ORGANIZATION_EVENT_TYPES = Object.freeze({
  created: 'organization.created.v1',
  renamed: 'organization.renamed.v1',
  suspended: 'organization.suspended.v1',
  reactivated: 'organization.reactivated.v1',
  archived: 'organization.archived.v1',
} as const);

export type OrganizationEventType =
  (typeof ORGANIZATION_EVENT_TYPES)[keyof typeof ORGANIZATION_EVENT_TYPES];

export const MEMBERSHIP_EVENT_TYPES = Object.freeze({
  added: 'organization.membership.added.v1',
  roleChanged: 'organization.membership.role.changed.v1',
  revoked: 'organization.membership.revoked.v1',
} as const);

export type MembershipEventType =
  (typeof MEMBERSHIP_EVENT_TYPES)[keyof typeof MEMBERSHIP_EVENT_TYPES];

export const INVITATION_EVENT_TYPES = Object.freeze({
  created: 'organization.invitation.created.v1',
  accepted: 'organization.invitation.accepted.v1',
  revoked: 'organization.invitation.revoked.v1',
} as const);

export type InvitationEventType =
  (typeof INVITATION_EVENT_TYPES)[keyof typeof INVITATION_EVENT_TYPES];
