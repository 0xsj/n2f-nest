import { Injectable } from '@nestjs/common';
import { ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type {
  OrganizationMembershipView,
  OrganizationReader,
} from '../../app/index.js';
import { InMemoryOrganizationStore } from './store.js';

@Injectable()
export class InMemoryOrganizationReader implements OrganizationReader {
  constructor(private readonly store: InMemoryOrganizationStore) {}

  async listForIdentity(
    identityId: ID,
  ): Promise<Result<readonly OrganizationMembershipView[], Failure>> {
    const memberships = this.store.membershipsForIdentity(identityId);
    const views: OrganizationMembershipView[] = [];

    for (const membership of memberships) {
      const organization = this.store.organizationById(
        membership.organizationId,
      );
      if (organization?.status !== 'archived') {
        if (organization) views.push({ organization, membership });
      }
    }

    return ok(views);
  }
}
