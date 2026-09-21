import { readFileSync } from 'node:fs';
import type { Migration } from '../../../../shared/postgres/index.js';

export const migration = (version: number): Migration => ({
  version,
  sql: readFileSync(
    new URL('./migrations/0009_documents.sql', import.meta.url),
    'utf8',
  ),
});

export const processingMigration = (version: number): Migration => ({
  version,
  sql: readFileSync(
    new URL('./migrations/0011_document_processing.sql', import.meta.url),
    'utf8',
  ),
});
