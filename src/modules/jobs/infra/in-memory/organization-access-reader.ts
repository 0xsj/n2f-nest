import { Injectable } from '@nestjs/common';
import { GetOrganizationMembership } from '../../../organization/app/index.js';
import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type {
  JobOrganizationAccess,
  JobOrganizationAccessReader,
} from '../../app/index.js';

@Injectable()
export class OrganizationAccessReaderAdapter implements JobOrganizationAccessReader {
  constructor(private readonly membership: GetOrganizationMembership) {}

  async find(
    sessionToken: SecretString,
    organizationId: ID,
    signal?: AbortSignal,
  ): Promise<Result<JobOrganizationAccess | null, Failure>> {
    const result = await this.membership.execute({
      sessionToken,
      organizationId,
      signal,
    });
    if (!result.ok) return result;
    if (
      result.value === null ||
      result.value.organization.status !== 'active' ||
      result.value.membership.status !== 'active'
    ) {
      return { ok: true, value: null };
    }
    return {
      ok: true,
      value: {
        organizationId: result.value.organization.id,
        identityId: result.value.membership.identityId,
        role: result.value.membership.role,
      },
    };
  }
}
