import { readFileSync } from 'node:fs';
import type { Migration } from '../../../../shared/postgres/index.js';

export const migration = (version: number): Migration => ({
  version,
  sql: readFileSync(
    new URL('./migrations/0006_audit.sql', import.meta.url),
    'utf8',
  ),
});
