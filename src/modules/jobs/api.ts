/**
 * Jobs' public surface. Code outside this module imports this file and
 * nothing else from it; see notes/architecture/hardening-bar.md (Boundaries).
 * Commands live in commands.ts, which only workflows may import.
 */
export { JobsModule } from './jobs.module.js';

/** Capabilities the composition root must supply to JobsModule. */
export { JOBS_REQUIRES } from './infra/requires.js';
export type {
  JobOrganizationAccess,
  JobOrganizationAccessReader,
  JobOrganizationRole,
} from './app/index.js';

export { baselineMigration as jobsBaselineMigration } from './infra/postgres/index.js';
