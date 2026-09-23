import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { perClient, RateLimit } from '../../../../platform/ratelimit/index.js';
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
  RequestDocumentProcessing,
  type RequestDocumentProcessingResult,
} from '../../app/request-document-processing.js';
import { DocumentProcessingHttpWork } from './work.js';

type BodyObject = Record<string, unknown>;

function objectBody(value: unknown): Result<BodyObject, Failure> {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return err(failure('invalid', 'invalid request body', { type: 'http.invalid_body' }));
  }
  return { ok: true, value: value as BodyObject };
}

function processBody(value: unknown): Result<{ maxAttempts?: unknown }, Failure> {
  const object = objectBody(value);
  if (
    !object.ok ||
    Object.keys(object.value).some((key) => key !== 'maxAttempts')
  ) {
    return err(failure('invalid', 'invalid request body', { type: 'http.invalid_body' }));
  }
  return { ok: true, value: { maxAttempts: object.value.maxAttempts } };
}

function parameter(value: string | undefined): Result<ID, Failure> {
  if (value === undefined) {
    return err(failure('invalid', 'required route parameter is missing', { type: 'http.invalid_parameter' }));
  }
  return parse(value);
}

function bearer(value: string | undefined): Result<SecretString, Failure> {
  if (!value || !/^Bearer [^\s]+$/.test(value)) {
    return err(failure('unauthenticated', 'bearer token is required', { type: 'document.missing_token' }));
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

/** Per-client bound on this controller's requests; see platform/ratelimit. */
@RateLimit(perClient('document_processing', 120, 60_000))
@Controller('organizations/:organizationId/documents')
export class DocumentProcessingController {
  constructor(
    private readonly request: RequestDocumentProcessing,
    private readonly work: DocumentProcessingHttpWork,
  ) {}

  @Post(':documentId/process')
  @HttpCode(HttpStatus.CREATED)
  async processDocument(
    @Param('organizationId') organizationIdValue: string | undefined,
    @Param('documentId') documentIdValue: string | undefined,
    @Body() rawBody: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    const organizationId = respond(parameter(organizationIdValue));
    const documentId = respond(parameter(documentIdValue));
    const input = respond(processBody(rawBody));
    const sessionToken = respond(bearer(authorization));
    const work = respond(this.work.open('document.processing.request'));
    const result = respond<RequestDocumentProcessingResult>(
      await this.request.execute({
        sessionToken,
        organizationId,
        documentId,
        maxAttempts: input.maxAttempts,
        work,
      }),
    );
    return {
      documentId: result.documentId,
      jobId: result.jobId,
      documentStatus: result.documentStatus,
      jobStatus: result.jobStatus,
      jobCreated: result.jobCreated,
    };
  }
}
