import {
  err,
  failure,
  ok,
  type Result,
} from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import type { WallClock } from '../../../../shared/clock/index.js';
import type { ID, IDGenerator } from '../../../../shared/id/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import { JOB_EVENT_TYPES, Job, type JobSubject } from '../../domain/index.js';
import type { JobReader, JobWriter } from '../ports/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type JobsApplicationFailure,
} from '../failures.js';

export type SubmitWorkflowJobCommand = Readonly<{
  organizationId: ID;
  kind: string;
  subject: JobSubject;
  maxAttempts?: unknown;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type SubmitWorkflowJobDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  jobs: JobReader;
  writer: JobWriter;
}>;

export type SubmitWorkflowJobResult = Readonly<{
  jobId: ID;
  status: Job['status'];
  created: boolean;
}>;

function nextId(ids: IDGenerator): Result<ID, JobsApplicationFailure> {
  const generated = ids.newId();
  return generated.ok
    ? generated
    : err(idGenerationFailure(generated.error));
}

/**
 * Internal application port used by a workflow. It deliberately has no
 * session-token parameter: the workflow is the trusted composition boundary,
 * while public user actions continue through SubmitJob and its authorization.
 */
export class SubmitWorkflowJob {
  constructor(private readonly dependencies: SubmitWorkflowJobDependencies) {}

  /**
   * Ensure the subject has an open job: return a queued or running one, retry
   * a failed one that has attempts left, or create a new one when the subject
   * has none (or only finished ones). Concurrent calls converge on one job.
   */
  async execute(
    command: SubmitWorkflowJobCommand,
  ): Promise<Result<SubmitWorkflowJobResult, JobsApplicationFailure>> {
    if (command.work.snapshot().operation !== 'job.submit.workflow') {
      return err(
        failure('invalid', 'workflow job operation is invalid', {
          type: 'job.invalid_operation',
        }),
      );
    }

    const existing = await this.open(command);
    if (!existing.ok) return existing;
    if (existing.value) return this.reuse(existing.value, command);

    const createdAt = this.dependencies.clock.now();
    const jobId = nextId(this.dependencies.ids);
    if (!jobId.ok) return jobId;
    const job = Job.create({
      id: jobId.value,
      organizationId: command.organizationId,
      kind: command.kind,
      subject: command.subject,
      maxAttempts: command.maxAttempts,
      createdAt,
    });
    if (!job.ok) return job;

    const event = this.event(job.value, JOB_EVENT_TYPES.submitted, createdAt, command);
    if (!event.ok) return event;
    const committed = await this.dependencies.writer.commit({
      mode: 'create',
      job: job.value,
      event: event.value,
      work: command.work,
      signal: command.signal,
    });
    if (!committed.ok) {
      // A concurrent submission for the same subject committed first. The
      // workflow asked for "an open job for this subject", so use that one.
      if (committed.error.type === 'job.subject_taken') {
        const winner = await this.open(command);
        if (!winner.ok) return winner;
        if (winner.value) return this.reuse(winner.value, command);
      }
      return err(dependencyFailure(committed.error, 'job.commit'));
    }

    return ok({ jobId: job.value.id, status: job.value.status, created: true });
  }

  /** Return an open job as it is, or queue a failed one for another attempt. */
  private async reuse(
    job: Job,
    command: SubmitWorkflowJobCommand,
  ): Promise<Result<SubmitWorkflowJobResult, JobsApplicationFailure>> {
    if (job.status !== 'failed') {
      return ok({ jobId: job.id, status: job.status, created: false });
    }
    const at = this.dependencies.clock.now();
    const retried = job.retry(at);
    if (!retried.ok) return retried;
    const event = this.event(retried.value, JOB_EVENT_TYPES.retried, at, command);
    if (!event.ok) return event;
    const committed = await this.dependencies.writer.commit({
      mode: 'update',
      job: retried.value,
      event: event.value,
      work: command.work,
      signal: command.signal,
    });
    if (!committed.ok) return err(dependencyFailure(committed.error, 'job.commit'));
    return ok({ jobId: job.id, status: retried.value.status, created: false });
  }

  private event(
    job: Job,
    type: (typeof JOB_EVENT_TYPES)[keyof typeof JOB_EVENT_TYPES],
    at: Date,
    command: SubmitWorkflowJobCommand,
  ): Result<Envelope, JobsApplicationFailure> {
    const eventId = nextId(this.dependencies.ids);
    if (!eventId.ok) return eventId;
    const event = Envelope.create(
      eventId.value,
      type,
      at.getTime(),
      command.work,
      {
        organization_id: job.organizationId,
        job_id: job.id,
        kind: job.kind,
        subject: job.subject,
        status: job.status,
        attempts: job.attempts,
        max_attempts: job.maxAttempts,
      },
      { kind: 'job', id: job.id },
      job.organizationId,
    );
    return event.ok ? event : err(dependencyFailure(event.error, 'event.create'));
  }

  private async open(
    command: SubmitWorkflowJobCommand,
  ): Promise<Result<Job | null, JobsApplicationFailure>> {
    const found = await this.dependencies.jobs.findOpenBySubject(
      command.organizationId,
      command.kind,
      command.subject,
      command.signal,
    );
    return found.ok
      ? found
      : err(dependencyFailure(found.error, 'job.findOpenBySubject'));
  }
}
