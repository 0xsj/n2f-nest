/**
 * Bridges between modules. Each bridge implements one module's required port
 * by calling another module's public query; see
 * notes/architecture/hardening-bar.md (Boundaries). Bridges never call
 * commands: commands cross modules only through workflows.
 */
export {
  auditOrganizationAccess,
  OrganizationAccessBridge,
  type OrganizationAccessView,
} from './organization-access.js';
export { documentOrganizationAccess } from './document-access.js'; // example
export { jobsOrganizationAccess } from './jobs-access.js'; // example
export {
  IdentityCurrentActorBridge,
  IdentityReferenceBridge,
  OrganizationIdentityBridge,
} from './organization-identity.js';
