import { Inject, Injectable } from '@nestjs/common';
import { err, ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import { assertEventWork } from '../../../../shared/events/index.js';
import { EVENT_BUS, type EventBus } from '../../../../platform/events/event-bus.js';
import type {
  InvitationAcceptanceCommit,
  InvitationAcceptanceWriter,
} from '../../app/index.js';
import { acceptanceConflict, acceptedMembershipExists } from '../failures.js';
import { InMemoryOrganizationStore } from './store.js';

/**
 * Mirrors the PostgreSQL writer: only a pending invitation at the version the
 * command read can be accepted, and the identity may hold one membership.
 */
@Injectable()
export class InMemoryInvitationAcceptanceWriter implements InvitationAcceptanceWriter {
  constructor(
    private readonly store: InMemoryOrganizationStore,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async commit(
    input: InvitationAcceptanceCommit,
  ): Promise<Result<void, Failure>> {
    for (const event of input.events) {
      const provenance = assertEventWork(event, input.work);
      if (!provenance.ok) return provenance;
    }

    const previousInvitation = this.store.invitationById(input.invitation.id);
    if (
      !previousInvitation ||
      previousInvitation.status !== 'pending' ||
      previousInvitation.version !== input.invitation.version
    ) {
      return err(acceptanceConflict());
    }
    const membership = input.membership;
    const duplicate =
      this.store.membershipById(membership.id) !== undefined ||
      this.store
        .membershipsForAnyStatusForIdentity(membership.identityId)
        .some((candidate) => candidate.organizationId === membership.organizationId);
    if (duplicate) return err(acceptedMembershipExists());

    this.store.replaceInvitation(input.invitation.saved());
    this.store.addMembership(membership.saved());
    for (const event of input.events) {
      const published = await this.events.publish(event, input.signal);
      if (!published.ok) {
        this.store.replaceInvitation(previousInvitation);
        this.store.removeMembership(membership.id);
        return published;
      }
    }
    return ok(undefined);
  }
}
