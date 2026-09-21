import {
  err,
  ok,
  typedFailure,
  type TypedFailure,
  type Result,
} from '../../../shared/errors/index.js';
import { parse, type ID } from '../../../shared/id/index.js';

export const JOB_STATUSES = Object.freeze([
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
] as const);
export type JobStatus = (typeof JOB_STATUSES)[number];

export type JobFailureType =
  | 'job.invalid_kind'
  | 'job.invalid_subject'
  | 'job.invalid_attempts'
  | 'job.invalid_failure_code'
  | 'job.invalid_created_at'
  | 'job.invalid_state'
  | 'job.non_monotonic_time'
  | 'job.invalid_time'
  | 'job.not_queued'
  | 'job.attempts_exhausted'
  | 'job.not_running'
  | 'job.not_failed'
  | 'job.not_cancelable';

export type JobFailure = TypedFailure<'invalid', JobFailureType>;

/**
 * An opaque application-level subject. Jobs may point at a resource without
 * importing that resource's domain model.
 */
export type JobSubject = Readonly<{
  type: string;
  id: ID;
}>;

export type CreateJobInput = Readonly<{
  id: ID;
  organizationId: ID;
  kind: unknown;
  subject?: unknown;
  maxAttempts?: unknown;
  createdAt: Date;
}>;

export type RestoreJobInput = Readonly<{
  id: ID;
  organizationId: ID;
  kind: string;
  subject: JobSubject | null;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  failureCode: string | null;
}>;

type JobState = Readonly<{
  id: ID;
  organizationId: ID;
  kind: string;
  subject: JobSubject | null;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  failureCode: string | null;
}>;

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function copyDate(value: Date): Date {
  return new Date(value.getTime());
}

function invalid(message: string, type: JobFailureType): JobFailure {
  return typedFailure('invalid', type, message);
}

function kind(value: unknown): Result<string, JobFailure> {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_.-]{0,119}$/.test(value)) {
    return err(invalid('job kind is invalid', 'job.invalid_kind'));
  }
  return ok(value);
}

function subject(value: unknown): Result<JobSubject | null, JobFailure> {
  if (value === undefined || value === null) return ok(null);
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.hasOwn(value, 'type') ||
    !Object.hasOwn(value, 'id')
  ) {
    return err(invalid('job subject is invalid', 'job.invalid_subject'));
  }

  const input = value as { type?: unknown; id?: unknown };
  if (
    typeof input.type !== 'string' ||
    !/^[a-z][a-z0-9_.-]{0,63}$/.test(input.type) ||
    typeof input.id !== 'string'
  ) {
    return err(invalid('job subject is invalid', 'job.invalid_subject'));
  }
  const id = parse(input.id);
  if (!id.ok)
    return err(invalid('job subject is invalid', 'job.invalid_subject'));
  return ok(Object.freeze({ type: input.type, id: id.value }));
}

function attempts(value: unknown): Result<number, JobFailure> {
  if (value === undefined) return ok(3);
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 10
  ) {
    return err(
      invalid(
        'job max attempts must be between 1 and 10',
        'job.invalid_attempts',
      ),
    );
  }
  return ok(value);
}

function failureCode(value: unknown): Result<string, JobFailure> {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_.-]{0,127}$/.test(value)) {
    return err(
      invalid('job failure code is invalid', 'job.invalid_failure_code'),
    );
  }
  return ok(value);
}

export class Job {
  private constructor(private readonly state: JobState) {
    Object.freeze(this.state);
  }

  static create(input: CreateJobInput): Result<Job, JobFailure> {
    const jobKind = kind(input.kind);
    if (!jobKind.ok) return jobKind;
    const maxAttempts = attempts(input.maxAttempts);
    if (!maxAttempts.ok) return maxAttempts;
    const jobSubject = subject(input.subject);
    if (!jobSubject.ok) return jobSubject;
    if (!validDate(input.createdAt)) {
      return err(
        invalid('job creation time is invalid', 'job.invalid_created_at'),
      );
    }

    const createdAt = copyDate(input.createdAt);
    return ok(
      new Job({
        id: input.id,
        organizationId: input.organizationId,
        kind: jobKind.value,
        subject: jobSubject.value,
        status: 'queued',
        attempts: 0,
        maxAttempts: maxAttempts.value,
        createdAt,
        updatedAt: copyDate(createdAt),
        startedAt: null,
        finishedAt: null,
        failureCode: null,
      }),
    );
  }

  static restore(input: RestoreJobInput): Result<Job, JobFailure> {
    const jobKind = kind(input.kind);
    if (!jobKind.ok) return jobKind;
    const jobSubject = subject(input.subject);
    if (!jobSubject.ok) return jobSubject;
    if (
      !JOB_STATUSES.includes(input.status) ||
      !Number.isSafeInteger(input.attempts) ||
      !Number.isSafeInteger(input.maxAttempts) ||
      input.attempts < 0 ||
      input.maxAttempts < 1 ||
      input.maxAttempts > 10 ||
      input.attempts > input.maxAttempts ||
      !validDate(input.createdAt) ||
      !validDate(input.updatedAt) ||
      (input.startedAt !== null && !validDate(input.startedAt)) ||
      (input.finishedAt !== null && !validDate(input.finishedAt)) ||
      (input.failureCode !== null &&
        !/^[a-z][a-z0-9_.-]{0,127}$/.test(input.failureCode))
    ) {
      return err(invalid('job state is invalid', 'job.invalid_state'));
    }
    if (input.updatedAt.getTime() < input.createdAt.getTime()) {
      return err(
        invalid(
          'job update time cannot precede creation',
          'job.non_monotonic_time',
        ),
      );
    }
    if (
      (input.status === 'queued' &&
        (input.startedAt !== null ||
          input.finishedAt !== null ||
          input.failureCode !== null)) ||
      (input.status === 'running' &&
        (input.startedAt === null ||
          input.finishedAt !== null ||
          input.failureCode !== null ||
          input.attempts < 1)) ||
      (input.status === 'succeeded' &&
        (input.startedAt === null ||
          input.finishedAt === null ||
          input.failureCode !== null)) ||
      (input.status === 'failed' &&
        (input.startedAt === null ||
          input.finishedAt === null ||
          input.failureCode === null)) ||
      (input.status === 'canceled' && input.finishedAt === null)
    ) {
      return err(
        invalid('job lifecycle state is invalid', 'job.invalid_state'),
      );
    }

    return ok(
      new Job({
        id: input.id,
        organizationId: input.organizationId,
        kind: jobKind.value,
        subject: jobSubject.value,
        status: input.status,
        attempts: input.attempts,
        maxAttempts: input.maxAttempts,
        createdAt: copyDate(input.createdAt),
        updatedAt: copyDate(input.updatedAt),
        startedAt: input.startedAt === null ? null : copyDate(input.startedAt),
        finishedAt:
          input.finishedAt === null ? null : copyDate(input.finishedAt),
        failureCode: input.failureCode,
      }),
    );
  }

  get id(): ID {
    return this.state.id;
  }
  get organizationId(): ID {
    return this.state.organizationId;
  }
  get kind(): string {
    return this.state.kind;
  }
  get subject(): JobSubject | null {
    return this.state.subject;
  }
  get status(): JobStatus {
    return this.state.status;
  }
  get attempts(): number {
    return this.state.attempts;
  }
  get maxAttempts(): number {
    return this.state.maxAttempts;
  }
  get createdAt(): Date {
    return copyDate(this.state.createdAt);
  }
  get updatedAt(): Date {
    return copyDate(this.state.updatedAt);
  }
  get startedAt(): Date | null {
    return this.state.startedAt === null
      ? null
      : copyDate(this.state.startedAt);
  }
  get finishedAt(): Date | null {
    return this.state.finishedAt === null
      ? null
      : copyDate(this.state.finishedAt);
  }
  get failureCode(): string | null {
    return this.state.failureCode;
  }

  start(at: Date): Result<Job, JobFailure> {
    const time = this.transitionTime(at);
    if (!time.ok) return time;
    if (this.status !== 'queued') {
      return err(invalid('only queued jobs can start', 'job.not_queued'));
    }
    if (this.attempts >= this.maxAttempts) {
      return err(
        invalid('job attempts are exhausted', 'job.attempts_exhausted'),
      );
    }
    return ok(
      this.evolve({
        status: 'running',
        attempts: this.attempts + 1,
        updatedAt: time.value,
        startedAt: time.value,
        finishedAt: null,
        failureCode: null,
      }),
    );
  }

  complete(at: Date): Result<Job, JobFailure> {
    const time = this.transitionTime(at);
    if (!time.ok) return time;
    if (this.status !== 'running') {
      return err(invalid('only running jobs can complete', 'job.not_running'));
    }
    return ok(
      this.evolve({
        status: 'succeeded',
        updatedAt: time.value,
        finishedAt: time.value,
      }),
    );
  }

  fail(at: Date, code: unknown): Result<Job, JobFailure> {
    const time = this.transitionTime(at);
    if (!time.ok) return time;
    if (this.status !== 'running') {
      return err(invalid('only running jobs can fail', 'job.not_running'));
    }
    const reason = failureCode(code);
    if (!reason.ok) return reason;
    return ok(
      this.evolve({
        status: 'failed',
        updatedAt: time.value,
        finishedAt: time.value,
        failureCode: reason.value,
      }),
    );
  }

  retry(at: Date): Result<Job, JobFailure> {
    const time = this.transitionTime(at);
    if (!time.ok) return time;
    if (this.status !== 'failed') {
      return err(invalid('only failed jobs can retry', 'job.not_failed'));
    }
    if (this.attempts >= this.maxAttempts) {
      return err(
        invalid('job attempts are exhausted', 'job.attempts_exhausted'),
      );
    }
    return ok(
      this.evolve({
        status: 'queued',
        updatedAt: time.value,
        startedAt: null,
        finishedAt: null,
        failureCode: null,
      }),
    );
  }

  cancel(at: Date): Result<Job, JobFailure> {
    const time = this.transitionTime(at);
    if (!time.ok) return time;
    if (this.status === 'succeeded' || this.status === 'canceled') {
      return err(
        invalid(
          'job cannot be canceled in its current state',
          'job.not_cancelable',
        ),
      );
    }
    return ok(
      this.evolve({
        status: 'canceled',
        updatedAt: time.value,
        finishedAt: time.value,
        failureCode: null,
      }),
    );
  }

  private transitionTime(at: Date): Result<Date, JobFailure> {
    if (!validDate(at))
      return err(invalid('job transition time is invalid', 'job.invalid_time'));
    if (at.getTime() < this.state.updatedAt.getTime()) {
      return err(
        invalid(
          'job transition time cannot move backwards',
          'job.non_monotonic_time',
        ),
      );
    }
    return ok(copyDate(at));
  }

  private evolve(patch: Partial<JobState>): Job {
    return new Job({ ...this.state, ...patch });
  }
}
