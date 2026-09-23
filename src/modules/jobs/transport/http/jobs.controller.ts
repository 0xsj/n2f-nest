import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { perClient, RateLimit } from '../../../../platform/ratelimit/index.js';
import type { Response } from 'express';
import {
  err,
  failure,
  publicInfo,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { problemOf } from '../../../../shared/http/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import {
  CancelJob,
  CompleteJob,
  FailJob,
  ListJobs,
  RetryJob,
  StartJob,
  SubmitJob,
  type TransitionJobCommand,
  type TransitionJobResult,
} from '../../app/index.js';
import type { Job } from '../../domain/index.js';
import { JobsHttpWork } from './work.js';

type BodyObject = Record<string, unknown>;

function objectBody(value: unknown): Result<BodyObject, Failure> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return err(failure('invalid', 'invalid request body', { type: 'http.invalid_body' }));
  }
  return { ok: true, value: value as BodyObject };
}

function submitBody(
  value: unknown,
): Result<{ kind: unknown; maxAttempts?: unknown }, Failure> {
  const object = objectBody(value);
  if (
    !object.ok ||
    Object.keys(object.value).some((key) => !['kind', 'maxAttempts'].includes(key)) ||
    !Object.hasOwn(object.value, 'kind')
  ) {
    return err(failure('invalid', 'invalid request body', { type: 'http.invalid_body' }));
  }
  return {
    ok: true,
    value: { kind: object.value.kind, maxAttempts: object.value.maxAttempts },
  };
}

function failureBody(value: unknown): Result<{ failureCode: unknown }, Failure> {
  const object = objectBody(value);
  if (!object.ok || Object.keys(object.value).length !== 1 || !Object.hasOwn(object.value, 'failureCode')) {
    return err(failure('invalid', 'invalid request body', { type: 'http.invalid_body' }));
  }
  return { ok: true, value: { failureCode: object.value.failureCode } };
}

function parameter(value: string | undefined): Result<ID, Failure> {
  if (value === undefined) {
    return err(failure('invalid', 'required route parameter is missing', { type: 'http.invalid_parameter' }));
  }
  return parse(value);
}

function bearer(value: string | undefined): Result<SecretString, Failure> {
  if (!value || !/^Bearer [^\s]+$/.test(value)) {
    return err(failure('unauthenticated', 'bearer token is required', { type: 'jobs.missing_token' }));
  }
  return { ok: true, value: new SecretString(value.slice(7)) };
}

function respond<T>(result: Result<T, Failure>): T {
  if (result.ok) return result.value;
  const problem = problemOf(result);
  throw new HttpException(
    problem ?? { ...publicInfo(result.error) },
    problem?.status ?? HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

function view(job: Job) {
  return {
    jobId: job.id,
    organizationId: job.organizationId,
    kind: job.kind,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    failureCode: job.failureCode,
    ...(job.subject
      ? { subject: { type: job.subject.type, id: job.subject.id } }
      : {}),
  };
}

/** Per-client bound on this controller's requests; see platform/ratelimit. */
@RateLimit(perClient('jobs', 120, 60_000))
@Controller('organizations/:organizationId/jobs')
export class JobsController {
  constructor(
    private readonly cancel: CancelJob,
    private readonly complete: CompleteJob,
    private readonly fail: FailJob,
    private readonly list: ListJobs,
    private readonly retry: RetryJob,
    private readonly start: StartJob,
    private readonly submit: SubmitJob,
    private readonly work: JobsHttpWork,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async submitJob(
    @Param('organizationId') organizationIdValue: string | undefined,
    @Body() rawBody: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    const organizationId = respond(parameter(organizationIdValue));
    const input = respond(submitBody(rawBody));
    const sessionToken = respond(bearer(authorization));
    const work = respond(this.work.open('job.submit'));
    return respond(await this.submit.execute({
      sessionToken,
      organizationId,
      kind: input.kind,
      maxAttempts: input.maxAttempts,
      work,
    }));
  }

  /** One page of jobs; `X-Next-Cursor` carries the cursor for the next. */
  @Get()
  async listJobs(
    @Param('organizationId') organizationIdValue: string | undefined,
    @Res({ passthrough: true }) response: Response,
    @Headers('authorization') authorization?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const organizationId = respond(parameter(organizationIdValue));
    const sessionToken = respond(bearer(authorization));
    const page = respond(await this.list.execute({ sessionToken, organizationId, limit, cursor }));
    if (page.nextCursor) response.setHeader('X-Next-Cursor', page.nextCursor);
    return page.items.map(view);
  }

  @Post(':jobId/start')
  @HttpCode(HttpStatus.OK)
  async startJob(
    @Param('organizationId') organizationIdValue: string | undefined,
    @Param('jobId') jobIdValue: string | undefined,
    @Headers('authorization') authorization?: string,
  ) {
    return this.transition('job.start', this.start, organizationIdValue, jobIdValue, authorization);
  }

  @Post(':jobId/complete')
  @HttpCode(HttpStatus.OK)
  async completeJob(
    @Param('organizationId') organizationIdValue: string | undefined,
    @Param('jobId') jobIdValue: string | undefined,
    @Headers('authorization') authorization?: string,
  ) {
    return this.transition('job.complete', this.complete, organizationIdValue, jobIdValue, authorization);
  }

  @Post(':jobId/fail')
  @HttpCode(HttpStatus.OK)
  async failJob(
    @Param('organizationId') organizationIdValue: string | undefined,
    @Param('jobId') jobIdValue: string | undefined,
    @Body() rawBody: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    const input = respond(failureBody(rawBody));
    return this.transition('job.fail', this.fail, organizationIdValue, jobIdValue, authorization, input.failureCode);
  }

  @Post(':jobId/retry')
  @HttpCode(HttpStatus.OK)
  async retryJob(
    @Param('organizationId') organizationIdValue: string | undefined,
    @Param('jobId') jobIdValue: string | undefined,
    @Headers('authorization') authorization?: string,
  ) {
    return this.transition('job.retry', this.retry, organizationIdValue, jobIdValue, authorization);
  }

  @Post(':jobId/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelJob(
    @Param('organizationId') organizationIdValue: string | undefined,
    @Param('jobId') jobIdValue: string | undefined,
    @Headers('authorization') authorization?: string,
  ) {
    return this.transition('job.cancel', this.cancel, organizationIdValue, jobIdValue, authorization);
  }

  private async transition(
    operationName: string,
    command: {
      execute(input: TransitionJobCommand): Promise<Result<TransitionJobResult, Failure>>;
    },
    organizationIdValue: string | undefined,
    jobIdValue: string | undefined,
    authorization: string | undefined,
    failureCode?: unknown,
  ) {
    const organizationId = respond(parameter(organizationIdValue));
    const jobId = respond(parameter(jobIdValue));
    const sessionToken = respond(bearer(authorization));
    const work = respond(this.work.open(operationName));
    return respond(await command.execute({ sessionToken, organizationId, jobId, work, failureCode }));
  }
}
