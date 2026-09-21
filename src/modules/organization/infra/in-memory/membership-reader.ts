import { Injectable } from '@nestjs/common';
import { ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { MembershipReader } from '../../app/index.js';
import type { Membership } from '../../domain/index.js';
import { InMemoryOrganizationStore } from './store.js';

@Injectable()
export class InMemoryMembershipReader implements MembershipReader {
  constructor(private readonly store: InMemoryOrganizationStore) {}

  async findById(
    membershipId: ID,
  ): Promise<Result<Membership | null, Failure>> {
    return ok(this.store.membershipById(membershipId) ?? null);
  }

  async findActiveForIdentity(
    organizationId: ID,
    identityId: ID,
  ): Promise<Result<Membership | null, Failure>> {
    const membership = this.store.membershipsForIdentity(identityId).find(
      (candidate) => candidate.organizationId === organizationId,
    );
    return ok(membership ?? null);
  }

  async findForIdentity(
    organizationId: ID,
    identityId: ID,
  ): Promise<Result<Membership | null, Failure>> {
    const membership = this.store.membershipsForAnyStatusForIdentity(identityId).find(
      (candidate) => candidate.organizationId === organizationId,
    );
    return ok(membership ?? null);
  }
}
