import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { AuditEntry } from '../../domain/index.js';

export type AuditWriteResult = Readonly<{
  entry: AuditEntry;
  created: boolean;
}>;

/** Persists an audit entry idempotently by source event ID. */
export interface AuditEntryWriter {
  record(
    entry: AuditEntry,
    signal?: AbortSignal,
  ): Promise<Result<AuditWriteResult, Failure>>;
}
