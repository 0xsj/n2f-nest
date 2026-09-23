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
import { UNSAVED } from '../../../../shared/version/index.js';
import type { MembershipCommit, MembershipWriter } from '../../app/index.js';
import { membershipExists, membershipNotFound, staleWrite } from '../failures.js';
import { InMemoryOrganizationStore } from './store.js';

/** Mirrors the PostgreSQL writer: unique per organization and identity, version-checked updates. */
@Injectable()
export class InMemoryMembershipWriter implements MembershipWriter {
  constructor(
    private readonly store: InMemoryOrganizationStore,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async commit(input: MembershipCommit): Promise<Result<void, Failure>> {
    const provenance = assertEventWork(input.event, input.work);
    if (!provenance.ok) return provenance;
    const membership = input.membership;

    const existing = this.store.membershipById(membership.id);
    if (membership.version === UNSAVED) {
      const duplicate = this.store
        .membershipsForAnyStatusForIdentity(membership.identityId)
        .some((candidate) => candidate.organizationId === membership.organizationId);
      if (existing || duplicate) return err(membershipExists());
      this.store.addMembership(membership.saved());
    } else {
      if (!existing) return err(membershipNotFound());
      if (existing.version !== membership.version) return err(staleWrite());
      this.store.replaceMembership(membership.saved());
    }

    const published = await this.events.publish(input.event, input.signal);
    if (!published.ok) {
      if (existing) this.store.replaceMembership(existing);
      else this.store.removeMembership(membership.id);
      return published;
    }

    return ok(undefined);
  }
}
