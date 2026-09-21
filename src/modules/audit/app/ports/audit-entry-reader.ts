import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { AuditEntry } from '../../domain/index.js';

export interface AuditEntryReader {
  list(signal?: AbortSignal): Promise<Result<readonly AuditEntry[], Failure>>;
}
