import { readFileSync } from 'node:fs';
import type { Migration } from '../../shared/postgres/index.js';

export const namespaceMigration = (version: number): Migration => ({
  version,
  sql: readFileSync(new URL('./0013_namespace_rename.sql', import.meta.url), 'utf8'),
});
