import { readFileSync } from 'node:fs';
import type { Migration } from '../../../../shared/postgres/index.js';

/** This module's baseline schema; see migrations/baseline.sql. */
export const baselineMigration = (version: number): Migration => ({
  version,
  sql: readFileSync(new URL('./migrations/baseline.sql', import.meta.url), 'utf8'),
});
