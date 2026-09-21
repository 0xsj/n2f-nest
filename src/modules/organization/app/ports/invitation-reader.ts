import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { Invitation } from '../../domain/index.js';

export interface InvitationReader {
  findById(
    invitationId: ID,
    signal?: AbortSignal,
  ): Promise<Result<Invitation | null, Failure>>;

  findPendingForIdentity(
    organizationId: ID,
    identityId: ID,
    signal?: AbortSignal,
  ): Promise<Result<Invitation | null, Failure>>;
}
