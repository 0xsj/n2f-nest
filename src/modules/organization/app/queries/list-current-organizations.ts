import type { Result } from '../../../../shared/errors/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type {
  CurrentActorReader,
  OrganizationMembershipView,
  OrganizationReader,
} from '../ports/index.js';
import { dependencyFailure, type OrganizationApplicationFailure } from '../failures.js';

export type ListCurrentOrganizationsQuery = Readonly<{
  sessionToken: SecretString;
  signal?: AbortSignal;
}>;

export type ListCurrentOrganizationsDependencies = Readonly<{
  actors: CurrentActorReader;
  organizations: OrganizationReader;
}>;

export class ListCurrentOrganizations {
  constructor(
    private readonly dependencies: ListCurrentOrganizationsDependencies,
  ) {}

  async execute(
    query: ListCurrentOrganizationsQuery,
  ): Promise<Result<readonly OrganizationMembershipView[], OrganizationApplicationFailure>> {
    const actor = await this.dependencies.actors.findCurrent(
      query.sessionToken,
      query.signal,
    );
    if (!actor.ok) return { ok: false, error: dependencyFailure(actor.error, 'identity.current.find') };

    const organizations = await this.dependencies.organizations.listForIdentity(
      actor.value.identityId,
      query.signal,
    );
    return organizations.ok
      ? organizations
      : { ok: false, error: dependencyFailure(organizations.error, 'organization.listForIdentity') };
  }
}
