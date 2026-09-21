import type { Envelope } from '../../../../shared/events/index.js';
import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { Job } from '../../domain/index.js';

export type JobCommit = Readonly<{
  mode: 'create' | 'update';
  job: Job;
  event: Envelope;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export interface JobWriter {
  commit(input: JobCommit): Promise<Result<void, Failure>>;
}
