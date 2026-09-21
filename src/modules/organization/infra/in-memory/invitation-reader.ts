import { Injectable } from '@nestjs/common';
import { ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { InvitationReader } from '../../app/index.js';
import type { Invitation } from '../../domain/index.js';
import { InMemoryOrganizationStore } from './store.js';

@Injectable()
export class InMemoryInvitationReader implements InvitationReader {
  constructor(private readonly store: InMemoryOrganizationStore) {}

  async findById(
    invitationId: ID,
  ): Promise<Result<Invitation | null, Failure>> {
    return ok(this.store.invitationById(invitationId) ?? null);
  }

  async findPendingForIdentity(
    organizationId: ID,
    identityId: ID,
  ): Promise<Result<Invitation | null, Failure>> {
    return ok(
      this.store
        .invitationsForIdentity(organizationId, identityId)
        .find((invitation) => invitation.status === 'pending') ?? null,
    );
  }
}
