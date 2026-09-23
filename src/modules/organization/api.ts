/**
 * Organization's public surface. Code outside this module imports this file
 * and nothing else from it; see notes/architecture/hardening-bar.md
 * (Boundaries).
 */
export { OrganizationModule } from './organization.module.js';
export {
  GetOrganizationMembership,
  type GetOrganizationMembershipQuery,
  type OrganizationMembershipView,
} from './app/index.js';

/** Capabilities the composition root must supply to OrganizationModule. */
export { ORGANIZATION_REQUIRES } from './infra/requires.js';
export type {
  CurrentActor,
  CurrentActorReader,
  IdentityReference,
  IdentityReferenceReader,
} from './app/index.js';

export { baselineMigration as organizationBaselineMigration } from './infra/postgres/index.js';
