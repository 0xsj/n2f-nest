import { Inject, Injectable } from '@nestjs/common';
import { err, ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import { assertEventWork } from '../../../../shared/events/index.js';
import { EVENT_BUS, type EventBus } from '../../../../platform/events/event-bus.js';
import { UNSAVED } from '../../../../shared/version/index.js';
import type { InvitationCommit, InvitationWriter } from '../../app/index.js';
import {
  invitationExists,
  invitationNotFound,
  pendingInvitationExists,
  staleWrite,
} from '../failures.js';
import { InMemoryOrganizationStore } from './store.js';

/** Mirrors the PostgreSQL writer: one pending invitation per identity, version-checked updates. */
@Injectable()
export class InMemoryInvitationWriter implements InvitationWriter {
  constructor(
    private readonly store: InMemoryOrganizationStore,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async commit(input: InvitationCommit): Promise<Result<void, Failure>> {
    const provenance = assertEventWork(input.event, input.work);
    if (!provenance.ok) return provenance;
    const invitation = input.invitation;

    const existing = this.store.invitationById(invitation.id);
    if (invitation.version === UNSAVED) {
      if (existing) return err(invitationExists());
      const pending = this.store
        .invitationsForIdentity(invitation.organizationId, invitation.identityId)
        .some((candidate) => candidate.status === 'pending');
      if (pending && invitation.status === 'pending') {
        return err(pendingInvitationExists());
      }
      this.store.addInvitation(invitation.saved());
    } else {
      if (!existing) return err(invitationNotFound());
      if (existing.version !== invitation.version) return err(staleWrite());
      this.store.replaceInvitation(invitation.saved());
    }

    const published = await this.events.publish(input.event, input.signal);
    if (!published.ok) {
      if (existing) this.store.replaceInvitation(existing);
      else this.store.removeInvitation(invitation.id);
      return published;
    }
    return ok(undefined);
  }
}
