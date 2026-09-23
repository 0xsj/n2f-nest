import { err, ok, type Result } from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import type { WallClock } from '../../../../shared/clock/index.js';
import type { IDGenerator } from '../../../../shared/id/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import { JOB_EVENT_TYPES } from '../../domain/index.js';
import type { JobReader, JobWriter } from '../ports/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type JobsApplicationFailure,
} from '../failures.js';

/** The failure code recorded for a job reclaimed after running too long. */
export const JOB_TIMED_OUT = 'job.timed_out';

export type ExpireStaleJobsCommand = Readonly<{
  /** Running jobs started longer ago than this are failed. */
  runningTimeoutMs: number;
  /** Upper bound on jobs expired per call. */
  limit: number;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type ExpireStaleJobsDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  jobs: JobReader;
  writer: JobWriter;
}>;

export type ExpireStaleJobsResult = Readonly<{ expired: number; skipped: number }>;

/**
 * Fails jobs left running past the timeout, typically because their executor
 * died. The failure is an ordinary `job.failed` (code `job.timed_out`), so a
 * job with attempts left can be retried and consumers react as to any failure.
 * A job changed concurrently (finished, or expired by another process) is
 * skipped: the version check refuses the stale write.
 */
export class ExpireStaleJobs {
  constructor(private readonly dependencies: ExpireStaleJobsDependencies) {}

  async execute(
    command: ExpireStaleJobsCommand,
  ): Promise<Result<ExpireStaleJobsResult, JobsApplicationFailure>> {
    const now = this.dependencies.clock.now();
    const stale = await this.dependencies.jobs.listRunningStartedBefore(
      new Date(now.getTime() - command.runningTimeoutMs),
      command.limit,
      command.signal,
    );
    if (!stale.ok) return err(dependencyFailure(stale.error, 'job.listRunningStartedBefore'));

    let expired = 0;
    let skipped = 0;
    for (const job of stale.value) {
      const failed = job.fail(now, JOB_TIMED_OUT);
      if (!failed.ok) {
        skipped += 1;
        continue;
      }
      const eventId = this.dependencies.ids.newId();
      if (!eventId.ok) return err(idGenerationFailure(eventId.error));
      const event = Envelope.create(
        eventId.value,
        JOB_EVENT_TYPES.failed,
        now.getTime(),
        command.work,
        {
          organization_id: failed.value.organizationId,
          job_id: failed.value.id,
          kind: failed.value.kind,
          subject: failed.value.subject,
          status: failed.value.status,
          attempts: failed.value.attempts,
          failure_code: failed.value.failureCode,
        },
        { kind: 'job', id: failed.value.id },
        failed.value.organizationId,
      );
      if (!event.ok) return err(dependencyFailure(event.error, 'event.create'));
      const committed = await this.dependencies.writer.commit({
        mode: 'update',
        job: failed.value,
        event: event.value,
        work: command.work,
        signal: command.signal,
      });
      if (committed.ok) expired += 1;
      else if (committed.error.type === 'job.stale_write') skipped += 1;
      else return err(dependencyFailure(committed.error, 'job.commit'));
    }
    return ok({ expired, skipped });
  }
}
