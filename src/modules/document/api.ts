/**
 * Document's public surface. Code outside this module imports this file and
 * nothing else from it; see notes/architecture/hardening-bar.md (Boundaries).
 * Commands live in commands.ts, which only workflows may import.
 */
export { DocumentModule } from './document.module.js';
export { CheckDocumentProcessable, type CheckDocumentProcessableQuery } from './app/index.js';

/** Capabilities the composition root must supply to DocumentModule. */
export { DOCUMENT_REQUIRES } from './infra/requires.js';
export type {
  OrganizationAccess,
  OrganizationAccessReader,
  OrganizationAccessRole,
} from './app/index.js';

export { baselineMigration as documentBaselineMigration } from './infra/postgres/index.js';
