/**
 * Audit's public surface. Code outside this module imports this file and
 * nothing else from it; see notes/architecture/hardening-bar.md (Boundaries).
 */
export { AuditModule } from './audit.module.js';

/** Capabilities the composition root must supply to AuditModule. */
export { AUDIT_REQUIRES } from './infra/requires.js';
export type {
  AuditOrganizationAccess,
  AuditOrganizationAccessReader,
  AuditOrganizationRole,
} from './app/index.js';
export { baselineMigration as auditBaselineMigration } from './infra/postgres/index.js';
