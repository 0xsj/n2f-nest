/**
 * Identity's public surface. Code outside this module imports this file and
 * nothing else from it; see notes/architecture/hardening-bar.md (Boundaries).
 */
export { IdentityModule } from './identity.module.js';
export { GetCurrentIdentity, GetIdentity, type IdentityView } from './app/index.js';
export {
  baselineMigration as identityBaselineMigration,
  passwordResetMigration as identityPasswordResetMigration,
  sessionActivityMigration as identitySessionActivityMigration,
} from './infra/postgres/index.js';
