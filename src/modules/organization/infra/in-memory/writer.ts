import { Inject, Injectable } from '@nestjs/common';
import {
  err,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { assertEventWork } from '../../../../shared/events/index.js';
import {
  EVENT_BUS,
  type EventBus,
} from '../../../../platform/events/event-bus.js';
import type { CreateOrganizationCommit, OrganizationWriter } from '../../app/index.js';
import {
  organizationExists,
  ownerMembershipExists,
  slugTaken,
} from '../failures.js';
import { InMemoryOrganizationStore } from './store.js';

@Injectable()
export class InMemoryOrganizationWriter implements OrganizationWriter {
  constructor(
    private readonly store: InMemoryOrganizationStore,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async commit(
    input: CreateOrganizationCommit,
  ): Promise<Result<void, Failure>> {
    for (const event of input.events) {
      const provenance = assertEventWork(event, input.work);
      if (!provenance.ok) return provenance;
    }

    if (this.store.organizationById(input.organization.id)) {
      return err(organizationExists());
    }
    if (this.store.organizationBySlug(input.organization.slug)) {
      return err(slugTaken());
    }
    if (this.store.membershipById(input.ownerMembership.id)) {
      return err(ownerMembershipExists());
    }

    this.store.addOrganization(input.organization.saved());
    this.store.addMembership(input.ownerMembership.saved());

    for (const event of input.events) {
      const published = await this.events.publish(event, input.signal);
      if (!published.ok) {
        this.store.removeMembership(input.ownerMembership.id);
        this.store.removeOrganization(input.organization.id);
        return published;
      }
    }

    return ok(undefined);
  }
}
