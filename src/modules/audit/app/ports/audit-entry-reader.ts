import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { After } from '../../../../shared/pagination/index.js';
import type { AuditEntry } from '../../domain/index.js';

export interface AuditEntryReader {
  /** The most recent entries across every tenant (development listing only). */
  list(signal?: AbortSignal): Promise<Result<readonly AuditEntry[], Failure>>;

  /** Up to `limit + 1` of one tenant's entries ordered by (recordedAt, id). */
  listForTenant(
    tenant: ID,
    page: Readonly<{ limit: number; after?: After }>,
    signal?: AbortSignal,
  ): Promise<Result<readonly AuditEntry[], Failure>>;
}
