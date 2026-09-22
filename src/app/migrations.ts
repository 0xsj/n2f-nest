import {
  migration as eventsMigration,
  receiptsMigration,
} from '../shared/events/postgres/index.js';
import {
  challengesMigration,
  migration as identityMigration,
  sessionsMigration,
} from '../modules/identity/infra/postgres/index.js';
import { migration as auditMigration } from '../modules/audit/infra/postgres/index.js';
import {
  migration as documentMigration,
  processingMigration as documentProcessingMigration,
} from '../modules/document/infra/postgres/index.js';
import {
  migration as jobsMigration,
  subjectMigration as jobsSubjectMigration,
} from '../modules/jobs/infra/postgres/index.js';
import {
  invitationsMigration as organizationInvitationsMigration,
  migration as organizationMigration,
} from '../modules/organization/infra/postgres/index.js';
import { namespaceMigration } from './migrations/namespace.js';

export const appMigrations = [
  eventsMigration(1),
  identityMigration(2),
  receiptsMigration(3),
  challengesMigration(4),
  sessionsMigration(5),
  auditMigration(6),
  organizationMigration(7),
  organizationInvitationsMigration(8),
  documentMigration(9),
  jobsMigration(10),
  jobsSubjectMigration(11),
  documentProcessingMigration(12),
  namespaceMigration(13),
] as const;
