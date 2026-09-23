import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { After } from '../../../../shared/pagination/index.js';
import type { Job, JobSubject } from '../../domain/index.js';

export interface JobReader {
  findById(id: ID, signal?: AbortSignal): Promise<Result<Job | null, Failure>>;
  /** The subject's open job (see `Job.open`), if any. */
  findOpenBySubject(
    organizationId: ID,
    kind: string,
    subject: JobSubject,
    signal?: AbortSignal,
  ): Promise<Result<Job | null, Failure>>;
  /** Running jobs started before `startedBefore`, oldest first, across organizations. */
  listRunningStartedBefore(
    startedBefore: Date,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Result<readonly Job[], Failure>>;
  /** Up to `limit + 1` jobs ordered by (createdAt, id), after `page.after`. */
  listForOrganization(
    organizationId: ID,
    page: Readonly<{ limit: number; after?: After }>,
    signal?: AbortSignal,
  ): Promise<Result<readonly Job[], Failure>>;
}
