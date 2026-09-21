import { Inject, Injectable } from '@nestjs/common';
import {
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { assertEventWork } from '../../../../shared/events/index.js';
import {
  EVENT_BUS,
  type EventBus,
} from '../../../../platform/events/event-bus.js';
import type { MembershipCommit, MembershipWriter } from '../../app/index.js';
import { InMemoryOrganizationStore } from './store.js';

@Injectable()
export class InMemoryMembershipWriter implements MembershipWriter {
  constructor(
    private readonly store: InMemoryOrganizationStore,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async commit(input: MembershipCommit): Promise<Result<void, Failure>> {
    const provenance = assertEventWork(input.event, input.work);
    if (!provenance.ok) return provenance;

    const existing = this.store.membershipById(input.membership.id);
    if (existing) {
      this.store.replaceMembership(input.membership);
    } else {
      this.store.addMembership(input.membership);
    }
    const published = await this.events.publish(input.event, input.signal);
    if (!published.ok) {
      if (existing) {
        this.store.replaceMembership(existing);
      } else {
        this.store.removeMembership(input.membership.id);
      }
      return published;
    }

    return ok(undefined);
  }
}
