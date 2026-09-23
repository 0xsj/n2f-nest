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
  ArchiveDocument,
  CreateDocument,
  GetDocument,
  ListDocuments,
} from '../../app/index.js';
import type { Document } from '../../domain/index.js';
import { DocumentHttpWork } from './work.js';

type BodyObject = Record<string, unknown>;

function objectBody(value: unknown): Result<BodyObject, Failure> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return err(failure('invalid', 'invalid request body', { type: 'http.invalid_body' }));
  }
  return { ok: true, value: value as BodyObject };
}

function documentBody(
  value: unknown,
): Result<{ name: unknown; storageKey?: unknown }, Failure> {
  const object = objectBody(value);
  if (
    !object.ok ||
    Object.keys(object.value).some((key) => !['name', 'storageKey'].includes(key)) ||
    !Object.hasOwn(object.value, 'name')
  ) {
    return err(failure('invalid', 'invalid request body', { type: 'http.invalid_body' }));
  }
  return {
    ok: true,
    value: {
      name: object.value.name,
      storageKey: object.value.storageKey,
    },
  };
}

function parameter(value: string | undefined): Result<ID, Failure> {
  if (value === undefined) {
    return err(
      failure('invalid', 'required route parameter is missing', {
        type: 'http.invalid_parameter',
      }),
    );
  }
  return parse(value);
}

function bearer(value: string | undefined): Result<SecretString, Failure> {
  if (!value || !/^Bearer [^\s]+$/.test(value)) {
    return err(
      failure('unauthenticated', 'bearer token is required', {
        type: 'document.missing_token',
      }),
    );
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

function view(document: Document) {
  return {
    documentId: document.id,
    organizationId: document.organizationId,
    name: document.name,
    storageKey: document.storageKey,
    status: document.status,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
    archivedAt: document.archivedAt?.toISOString() ?? null,
    ...(document.processingFailureCode
      ? { processingFailureCode: document.processingFailureCode }
      : {}),
  };
}

/** Per-client bound on this controller's requests; see platform/ratelimit. */
@RateLimit(perClient('document', 120, 60_000))
@Controller('organizations/:organizationId/documents')
export class DocumentController {
  constructor(
    private readonly archive: ArchiveDocument,
    private readonly create: CreateDocument,
    private readonly get: GetDocument,
    private readonly list: ListDocuments,
    private readonly work: DocumentHttpWork,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createDocument(
    @Param('organizationId') organizationIdValue: string | undefined,
    @Body() rawBody: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    const organizationId = respond(parameter(organizationIdValue));
    const input = respond(documentBody(rawBody));
    const sessionToken = respond(bearer(authorization));
    const work = respond(this.work.open('document.create'));
    return respond(
      await this.create.execute({
        sessionToken,
        organizationId,
        name: input.name,
        storageKey: input.storageKey,
        work,
      }),
    );
  }

  /** One page of documents; `X-Next-Cursor` carries the cursor for the next. */
  @Get()
  async listDocuments(
    @Param('organizationId') organizationIdValue: string | undefined,
    @Res({ passthrough: true }) response: Response,
    @Headers('authorization') authorization?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const organizationId = respond(parameter(organizationIdValue));
    const sessionToken = respond(bearer(authorization));
    const page = respond(
      await this.list.execute({ sessionToken, organizationId, limit, cursor }),
    );
    if (page.nextCursor) response.setHeader('X-Next-Cursor', page.nextCursor);
    return page.items.map(view);
  }

  @Get(':documentId')
  async getDocument(
    @Param('organizationId') organizationIdValue: string | undefined,
    @Param('documentId') documentIdValue: string | undefined,
    @Headers('authorization') authorization?: string,
  ) {
    const organizationId = respond(parameter(organizationIdValue));
    const documentId = respond(parameter(documentIdValue));
    const sessionToken = respond(bearer(authorization));
    const document = respond(
      await this.get.execute({ sessionToken, organizationId, documentId }),
    );
    return view(document);
  }

  @Post(':documentId/archive')
  @HttpCode(HttpStatus.OK)
  async archiveDocument(
    @Param('organizationId') organizationIdValue: string | undefined,
    @Param('documentId') documentIdValue: string | undefined,
    @Headers('authorization') authorization?: string,
  ) {
    const organizationId = respond(parameter(organizationIdValue));
    const documentId = respond(parameter(documentIdValue));
    const sessionToken = respond(bearer(authorization));
    const work = respond(this.work.open('document.archive'));
    return respond(
      await this.archive.execute({
        sessionToken,
        organizationId,
        documentId,
        work,
      }),
    );
  }
}
