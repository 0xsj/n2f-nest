import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { Envelope } from '../../../../shared/events/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { Membership, Organization } from '../../domain/index.js';

export type CreateOrganizationCommit = Readonly<{
  organization: Organization;
  ownerMembership: Membership;
  events: readonly Envelope[];
  work: WorkContext;
  signal?: AbortSignal;
}>;

/** Persists organization state and its owner/event facts atomically. */
export interface OrganizationWriter {
  commit(
    input: CreateOrganizationCommit,
  ): Promise<Result<void, Failure>>;
}
