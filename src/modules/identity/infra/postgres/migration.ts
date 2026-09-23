import { readFileSync } from 'node:fs';
import type { Migration } from '../../../../shared/postgres/index.js';

/** This module's baseline schema; see migrations/baseline.sql. */
export const baselineMigration = (version: number): Migration => ({
  version,
  sql: readFileSync(new URL('./migrations/baseline.sql', import.meta.url), 'utf8'),
});

/** Session activity (`last_seen_at`) for idle expiry, the session cap and pruning. */
export const sessionActivityMigration = (version: number): Migration => ({
  version,
  sql: readFileSync(new URL('./migrations/session-activity.sql', import.meta.url), 'utf8'),
});

/** Verification challenges for password resets. */
export const passwordResetMigration = (version: number): Migration => ({
  version,
  sql: readFileSync(new URL('./migrations/password-reset.sql', import.meta.url), 'utf8'),
});
