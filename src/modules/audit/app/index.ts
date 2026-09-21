export {
  RecordAuditEvent,
  type RecordAuditEventCommand,
  type RecordAuditEventDependencies,
  type RecordAuditEventResult,
} from './commands/index.js';
export {
  ListAuditEntries,
  type AuditEntryView,
  type ListAuditEntriesDependencies,
} from './queries/index.js';
export {
  dependencyFailure,
  idGenerationFailure,
  type AuditApplicationFailure,
} from './failures.js';
export type {
  AuditEntryReader,
  AuditEntryWriter,
  AuditWriteResult,
} from './ports/index.js';
