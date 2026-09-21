import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';

export type OrganizationAccessRole = 'owner' | 'admin' | 'member';

export type OrganizationAccess = Readonly<{
  organizationId: ID;
  identityId: ID;
  role: OrganizationAccessRole;
}>;

export interface OrganizationAccessReader {
  find(
    sessionToken: SecretString,
    organizationId: ID,
    signal?: AbortSignal,
  ): Promise<Result<OrganizationAccess | null, Failure>>;
}
