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
import { JOB_EVENT_TYPES, Job } from '../../domain/index.js';
import type { JobOrganizationAccessReader, JobWriter } from '../ports/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type JobsApplicationFailure,
} from '../failures.js';

export type SubmitJobCommand = Readonly<{
  sessionToken: SecretString;
  organizationId: ID;
  kind: unknown;
  maxAttempts?: unknown;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type SubmitJobDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  access: JobOrganizationAccessReader;
  writer: JobWriter;
}>;

export type SubmitJobResult = Readonly<{
  jobId: ID;
  organizationId: ID;
  kind: string;
  status: 'queued';
  attempts: 0;
  maxAttempts: number;
}>;

function nextId(ids: IDGenerator): Result<ID, JobsApplicationFailure> {
  const generated = ids.newId();
  return generated.ok
    ? generated
    : err(idGenerationFailure(generated.error));
}

export class SubmitJob {
  constructor(private readonly dependencies: SubmitJobDependencies) {}

  async execute(
    command: SubmitJobCommand,
  ): Promise<Result<SubmitJobResult, JobsApplicationFailure>> {
    if (command.work.snapshot().operation !== 'job.submit') {
      return err(
        failure('invalid', 'job submission operation is invalid', {
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
          'only organization owners and admins can submit jobs',
          {
            type: 'job.submit_forbidden',
          },
        ),
      );
    }

    const createdAt = this.dependencies.clock.now();
    const jobId = nextId(this.dependencies.ids);
    if (!jobId.ok) return jobId;
    const job = Job.create({
      id: jobId.value,
      organizationId: command.organizationId,
      kind: command.kind,
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
        identity_id: access.value.identityId,
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
      organizationId: job.value.organizationId,
      kind: job.value.kind,
      status: 'queued',
      attempts: 0,
      maxAttempts: job.value.maxAttempts,
    });
  }
}
