import { readFileSync } from 'node:fs';
import type { Migration } from '../../../../shared/postgres/index.js';

export const migration = (version: number): Migration => ({
  version,
  sql: readFileSync(
    new URL('./migrations/0007_organization.sql', import.meta.url),
    'utf8',
  ),
});

export const invitationsMigration = (version: number): Migration => ({
  version,
  sql: readFileSync(
    new URL('./migrations/0008_organization_invitations.sql', import.meta.url),
    'utf8',
  ),
});
