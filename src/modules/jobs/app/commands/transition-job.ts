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
import type { SecretString } from '../../../../shared/secret/index.js';
import {
  JOB_EVENT_TYPES,
  type Job,
  type JobFailure,
  type JobEventType,
  type JobStatus,
} from '../../domain/index.js';
import type {
  JobOrganizationAccessReader,
  JobReader,
  JobWriter,
} from '../ports/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type JobsApplicationFailure,
} from '../failures.js';

export type TransitionJobCommand = Readonly<{
  sessionToken: SecretString;
  organizationId: ID;
  jobId: ID;
  failureCode?: unknown;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type TransitionJobDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  access: JobOrganizationAccessReader;
  jobs: JobReader;
  writer: JobWriter;
}>;

export type TransitionJobResult = Readonly<{
  jobId: ID;
  status: JobStatus;
  attempts: number;
  updatedAt: Date;
  finishedAt: Date | null;
}>;

type Action = 'start' | 'complete' | 'fail' | 'retry' | 'cancel';

function nextId(ids: IDGenerator): Result<ID, JobsApplicationFailure> {
  const generated = ids.newId();
  return generated.ok
    ? generated
    : err(idGenerationFailure(generated.error));
}

function transition(
  job: Job,
  action: Action,
  at: Date,
  failureCode: unknown,
): Result<Job, JobFailure> {
  switch (action) {
    case 'start':
      return job.start(at);
    case 'complete':
      return job.complete(at);
    case 'fail':
      return job.fail(at, failureCode);
    case 'retry':
      return job.retry(at);
    case 'cancel':
      return job.cancel(at);
  }
}

export class TransitionJob {
  constructor(
    private readonly dependencies: TransitionJobDependencies,
    private readonly action: Action,
    private readonly operation: string,
    private readonly eventType: JobEventType,
  ) {}

  async execute(
    command: TransitionJobCommand,
  ): Promise<Result<TransitionJobResult, JobsApplicationFailure>> {
    if (command.work.snapshot().operation !== this.operation) {
      return err(
        failure('invalid', 'job operation is invalid', {
          type: 'job.invalid_operation',
        }),
      );
    }
    const access = await this.dependencies.access.find(
      command.sessionToken,
      command.organizationId,
      command.signal,
    );
    if (!access.ok) return err(dependencyFailure(access.error, 'organization.access.find'));
    if (
      access.value === null ||
      (access.value.role !== 'owner' && access.value.role !== 'admin')
    ) {
      return err(
        failure(
          'forbidden',
          'only organization owners and admins can transition jobs',
          {
            type: 'job.transition_forbidden',
          },
        ),
      );
    }

    const current = await this.dependencies.jobs.findById(
      command.jobId,
      command.signal,
    );
    if (!current.ok) return err(dependencyFailure(current.error, 'job.findById'));
    if (
      current.value === null ||
      current.value.organizationId !== command.organizationId
    ) {
      return err(
        failure('not_found', 'job was not found', { type: 'job.not_found' }),
      );
    }

    const at = this.dependencies.clock.now();
    const changed = transition(
      current.value,
      this.action,
      at,
      command.failureCode,
    );
    if (!changed.ok) return changed;
    const eventId = nextId(this.dependencies.ids);
    if (!eventId.ok) return eventId;
    const event = Envelope.create(
      eventId.value,
      this.eventType,
      at.getTime(),
      command.work,
      {
        organization_id: changed.value.organizationId,
        job_id: changed.value.id,
        identity_id: access.value.identityId,
        kind: changed.value.kind,
        subject: changed.value.subject,
        status: changed.value.status,
        attempts: changed.value.attempts,
        failure_code: changed.value.failureCode,
      },
    );
    if (!event.ok) return err(dependencyFailure(event.error, 'event.create'));
    const committed = await this.dependencies.writer.commit({
      mode: 'update',
      job: changed.value,
      event: event.value,
      work: command.work,
      signal: command.signal,
    });
    if (!committed.ok) return err(dependencyFailure(committed.error, 'job.commit'));
    return ok({
      jobId: changed.value.id,
      status: changed.value.status,
      attempts: changed.value.attempts,
      updatedAt: changed.value.updatedAt,
      finishedAt: changed.value.finishedAt,
    });
  }
}

export class StartJob extends TransitionJob {
  constructor(dependencies: TransitionJobDependencies) {
    super(dependencies, 'start', 'job.start', JOB_EVENT_TYPES.started);
  }
}

export class CompleteJob extends TransitionJob {
  constructor(dependencies: TransitionJobDependencies) {
    super(dependencies, 'complete', 'job.complete', JOB_EVENT_TYPES.completed);
  }
}

export class FailJob extends TransitionJob {
  constructor(dependencies: TransitionJobDependencies) {
    super(dependencies, 'fail', 'job.fail', JOB_EVENT_TYPES.failed);
  }
}

export class RetryJob extends TransitionJob {
  constructor(dependencies: TransitionJobDependencies) {
    super(dependencies, 'retry', 'job.retry', JOB_EVENT_TYPES.retried);
  }
}

export class CancelJob extends TransitionJob {
  constructor(dependencies: TransitionJobDependencies) {
    super(dependencies, 'cancel', 'job.cancel', JOB_EVENT_TYPES.canceled);
  }
}
