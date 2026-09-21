import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { Membership } from '../../domain/index.js';

export interface MembershipReader {
  findById(
    membershipId: ID,
    signal?: AbortSignal,
  ): Promise<Result<Membership | null, Failure>>;

  findActiveForIdentity(
    organizationId: ID,
    identityId: ID,
    signal?: AbortSignal,
  ): Promise<Result<Membership | null, Failure>>;

  findForIdentity(
    organizationId: ID,
    identityId: ID,
    signal?: AbortSignal,
  ): Promise<Result<Membership | null, Failure>>;
}
