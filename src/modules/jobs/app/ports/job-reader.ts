import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { Job, JobSubject } from '../../domain/index.js';

export interface JobReader {
  findById(id: ID, signal?: AbortSignal): Promise<Result<Job | null, Failure>>;
  findBySubject(
    organizationId: ID,
    kind: string,
    subject: JobSubject,
    signal?: AbortSignal,
  ): Promise<Result<Job | null, Failure>>;
  listForOrganization(
    organizationId: ID,
    signal?: AbortSignal,
  ): Promise<Result<readonly Job[], Failure>>;
}
