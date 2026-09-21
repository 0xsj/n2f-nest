import { Inject, Injectable } from '@nestjs/common';
import { ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import { assertEventWork } from '../../../../shared/events/index.js';
import { EVENT_BUS, type EventBus } from '../../../../platform/events/event-bus.js';
import type {
  InvitationAcceptanceCommit,
  InvitationAcceptanceWriter,
} from '../../app/index.js';
import { InMemoryOrganizationStore } from './store.js';

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
    const previousMembership = this.store.membershipById(input.membership.id);
    if (!previousInvitation || previousMembership) {
      return {
        ok: false,
        error: {
          kind: 'conflict',
          message: 'invitation acceptance state already exists',
          type: 'organization.invitation.acceptance_conflict',
        },
      };
    }

    this.store.replaceInvitation(input.invitation);
    this.store.addMembership(input.membership);
    for (const event of input.events) {
      const published = await this.events.publish(event, input.signal);
      if (!published.ok) {
        this.store.replaceInvitation(previousInvitation);
        this.store.removeMembership(input.membership.id);
        return published;
      }
    }
    return ok(undefined);
  }
}
