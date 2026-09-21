import { Inject, Injectable } from '@nestjs/common';
import { err, ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import { assertEventWork } from '../../../../shared/events/index.js';
import { EVENT_BUS, type EventBus } from '../../../../platform/events/event-bus.js';
import type { InvitationCommit, InvitationWriter } from '../../app/index.js';
import { InMemoryOrganizationStore } from './store.js';

@Injectable()
export class InMemoryInvitationWriter implements InvitationWriter {
  constructor(
    private readonly store: InMemoryOrganizationStore,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async commit(input: InvitationCommit): Promise<Result<void, Failure>> {
    const provenance = assertEventWork(input.event, input.work);
    if (!provenance.ok) return provenance;
    const existing = this.store.invitationById(input.invitation.id);
    if (existing && input.event.type === 'organization.invitation.created.v1') {
      return err({
        kind: 'conflict',
        message: 'invitation already exists',
        type: 'organization.invitation_exists',
      });
    }

    if (existing) this.store.replaceInvitation(input.invitation);
    else this.store.addInvitation(input.invitation);
    const published = await this.events.publish(input.event, input.signal);
    if (!published.ok) {
      if (existing) this.store.replaceInvitation(existing);
      else this.store.removeInvitation(input.invitation.id);
      return published;
    }
    return ok(undefined);
  }
}
