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

    const existing = await this.dependencies.jobs.findBySubject(
      command.organizationId,
      command.kind,
      command.subject,
      command.signal,
    );
    if (!existing.ok) return err(dependencyFailure(existing.error, 'job.findBySubject'));
    if (existing.value) {
      return ok({
        jobId: existing.value.id,
        status: existing.value.status,
        created: false,
      });
    }

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

    const eventId = nextId(this.dependencies.ids);
    if (!eventId.ok) return eventId;
    const event = Envelope.create(
      eventId.value,
      JOB_EVENT_TYPES.submitted,
      createdAt.getTime(),
      command.work,
      {
        organization_id: job.value.organizationId,
        job_id: job.value.id,
        kind: job.value.kind,
        subject: job.value.subject,
        status: job.value.status,
        max_attempts: job.value.maxAttempts,
      },
    );
    if (!event.ok) return err(dependencyFailure(event.error, 'event.create'));

    const committed = await this.dependencies.writer.commit({
      mode: 'create',
      job: job.value,
      event: event.value,
      work: command.work,
      signal: command.signal,
    });
    if (!committed.ok) return err(dependencyFailure(committed.error, 'job.commit'));

    return ok({
      jobId: job.value.id,
      status: job.value.status,
      created: true,
    });
  }
}
