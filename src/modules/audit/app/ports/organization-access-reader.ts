import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';

export type AuditOrganizationRole = 'owner' | 'admin' | 'member';

export type AuditOrganizationAccess = Readonly<{
  organizationId: ID;
  identityId: ID;
  role: AuditOrganizationRole;
}>;

/** The caller's role in an organization, or null without active access. */
export interface AuditOrganizationAccessReader {
  find(
    sessionToken: SecretString,
    organizationId: ID,
    signal?: AbortSignal,
  ): Promise<Result<AuditOrganizationAccess | null, Failure>>;
}
