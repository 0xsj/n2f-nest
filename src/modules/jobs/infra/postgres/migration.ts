import { readFileSync } from 'node:fs';
import type { Migration } from '../../../../shared/postgres/index.js';

export const migration = (version: number): Migration => ({
  version,
  sql: readFileSync(
    new URL('./migrations/0010_jobs.sql', import.meta.url),
    'utf8',
  ),
});

export const subjectMigration = (version: number): Migration => ({
  version,
  sql: readFileSync(
    new URL('./migrations/0011_job_subject.sql', import.meta.url),
    'utf8',
  ),
});
