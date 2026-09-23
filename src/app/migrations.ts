import { baselineMigration as eventsBaselineMigration } from '../shared/events/postgres/index.js';
import {
  identityBaselineMigration,
  identityPasswordResetMigration,
  identitySessionActivityMigration,
} from '../modules/identity/api.js';
import { organizationBaselineMigration } from '../modules/organization/api.js';
import { documentBaselineMigration } from '../modules/document/api.js'; // example
import { jobsBaselineMigration } from '../modules/jobs/api.js'; // example
import { auditBaselineMigration } from '../modules/audit/api.js';
import { rateLimitBaselineMigration } from '../platform/ratelimit/postgres/index.js';

/**
 * Every schema change, in order. Versions 1–7 are the baselines squashed from
 * the v1.0.8 history; a database that applied that history is adopted onto
 * them without change (see shared/postgres `Database.migrate`). Add a new
 * migration with the next version number, owned by the module whose tables it
 * changes.
 */
export const appMigrations = [
  eventsBaselineMigration(1),
  identityBaselineMigration(2),
  organizationBaselineMigration(3),
  documentBaselineMigration(4), // example
  jobsBaselineMigration(5), // example
  auditBaselineMigration(6),
  rateLimitBaselineMigration(7),
  identitySessionActivityMigration(8),
  identityPasswordResetMigration(9),
] as const;

/**
 * The history squashed into versions 1–7: 26 migrations recorded in
 * `signals_migrations`. A database that applied all of it is adopted onto the
 * baselines unchanged (`test/migration-baseline.integration.spec.ts` proves
 * the schemas are identical); any other legacy state is refused.
 */
export const legacyHistory = Object.freeze({
  ledger: 'signals_migrations',
  versions: 26,
  finalChecksum: '2addb35aee3e11b9e9fbaa7465a41438652579c69177fe22e009ae25179ca239',
  baselineThrough: 7,
});