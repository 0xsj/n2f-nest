import { readFileSync } from 'node:fs';
import type { Migration } from '../../../../shared/postgres/index.js';

export const migration = (version: number): Migration => ({
  version,
  sql: readFileSync(
    new URL('./migrations/0002_identity.sql', import.meta.url),
    'utf8',
  ),
});

export const challengesMigration = (version: number): Migration => ({
  version,
  sql: readFileSync(
    new URL('./migrations/0004_verification_challenges.sql', import.meta.url),
    'utf8',
  ),
});

export const sessionsMigration = (version: number): Migration => ({
  version,
  sql: readFileSync(
    new URL('./migrations/0005_sessions.sql', import.meta.url),
    'utf8',
  ),
});
