import type { Invitation, Membership, Organization } from '../../domain/index.js';

export class InMemoryOrganizationStore {
  readonly #organizations = new Map<string, Organization>();
  readonly #memberships = new Map<string, Membership>();
  readonly #invitations = new Map<string, Invitation>();

  organizationById(id: string): Organization | undefined {
    return this.#organizations.get(id);
  }

  organizationBySlug(slug: string): Organization | undefined {
    return [...this.#organizations.values()].find(
      (organization) => organization.slug === slug,
    );
  }

  membershipById(id: string): Membership | undefined {
    return this.#memberships.get(id);
  }

  membershipsForIdentity(identityId: string): readonly Membership[] {
    return [...this.#memberships.values()].filter(
      (membership) =>
        membership.identityId === identityId && membership.status === 'active',
    );
  }

  membershipsForAnyStatusForIdentity(identityId: string): readonly Membership[] {
    return [...this.#memberships.values()].filter(
      (membership) => membership.identityId === identityId,
    );
  }

  invitationById(id: string): Invitation | undefined {
    return this.#invitations.get(id);
  }

  invitationsForIdentity(
    organizationId: string,
    identityId: string,
  ): readonly Invitation[] {
    return [...this.#invitations.values()].filter(
      (invitation) =>
        invitation.organizationId === organizationId &&
        invitation.identityId === identityId,
    );
  }

  addOrganization(organization: Organization): void {
    this.#organizations.set(organization.id, organization);
  }

  addMembership(membership: Membership): void {
    this.#memberships.set(membership.id, membership);
  }

  replaceMembership(membership: Membership): void {
    this.#memberships.set(membership.id, membership);
  }

  removeOrganization(id: string): void {
    this.#organizations.delete(id);
  }

  removeMembership(id: string): void {
    this.#memberships.delete(id);
  }

  addInvitation(invitation: Invitation): void {
    this.#invitations.set(invitation.id, invitation);
  }

  replaceInvitation(invitation: Invitation): void {
    this.#invitations.set(invitation.id, invitation);
  }

  removeInvitation(id: string): void {
    this.#invitations.delete(id);
  }
}
