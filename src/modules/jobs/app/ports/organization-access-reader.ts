import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';

export type JobOrganizationRole = 'owner' | 'admin' | 'member';

export type JobOrganizationAccess = Readonly<{
  organizationId: ID;
  identityId: ID;
  role: JobOrganizationRole;
}>;

export interface JobOrganizationAccessReader {
  find(
    sessionToken: SecretString,
    organizationId: ID,
    signal?: AbortSignal,
  ): Promise<Result<JobOrganizationAccess | null, Failure>>;
}
