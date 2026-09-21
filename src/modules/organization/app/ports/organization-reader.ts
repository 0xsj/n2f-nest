import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { Membership, Organization } from '../../domain/index.js';

export type OrganizationMembershipView = Readonly<{
  organization: Organization;
  membership: Membership;
}>;

/** Read-side boundary for organization contexts available to an Identity. */
export interface OrganizationReader {
  listForIdentity(
    identityId: ID,
    signal?: AbortSignal,
  ): Promise<Result<readonly OrganizationMembershipView[], Failure>>;
}
