import type { Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type {
  CurrentActorReader,
  OrganizationMembershipView,
  OrganizationReader,
} from '../ports/index.js';
import { dependencyFailure, type OrganizationApplicationFailure } from '../failures.js';

export type GetOrganizationMembershipQuery = Readonly<{
  sessionToken: SecretString;
  organizationId: ID;
  signal?: AbortSignal;
}>;

export type GetOrganizationMembershipDependencies = Readonly<{
  actors: CurrentActorReader;
  organizations: OrganizationReader;
}>;

export class GetOrganizationMembership {
  constructor(
    private readonly dependencies: GetOrganizationMembershipDependencies,
  ) {}

  async execute(
    query: GetOrganizationMembershipQuery,
  ): Promise<Result<OrganizationMembershipView | null, OrganizationApplicationFailure>> {
    const actor = await this.dependencies.actors.findCurrent(
      query.sessionToken,
      query.signal,
    );
    if (!actor.ok) return { ok: false, error: dependencyFailure(actor.error, 'identity.current.find') };

    const organizations = await this.dependencies.organizations.listForIdentity(
      actor.value.identityId,
      query.signal,
    );
    if (!organizations.ok) {
      return { ok: false, error: dependencyFailure(organizations.error, 'organization.listForIdentity') };
    }

    return {
      ok: true,
      value:
        organizations.value.find(
          ({ organization }) => organization.id === query.organizationId,
        ) ?? null,
    };
  }
}
