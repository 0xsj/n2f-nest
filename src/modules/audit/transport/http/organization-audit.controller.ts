import {
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { perClient, RateLimit } from '../../../../platform/ratelimit/index.js';
import {
  err,
  failure,
  publicInfo,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { problemOf } from '../../../../shared/http/index.js';
import { parse } from '../../../../shared/id/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import { ListOrganizationAuditEntries } from '../../app/index.js';

function respond<T>(result: Result<T, Failure>): T {
  if (result.ok) return result.value;
  const problem = problemOf(result);
  throw new HttpException(
    problem ?? { ...publicInfo(result.error) },
    problem?.status ?? HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

function bearer(value: string | undefined): Result<SecretString, Failure> {
  return value && /^Bearer [^\s]+$/.test(value)
    ? { ok: true, value: new SecretString(value.slice(7)) }
    : err(failure('unauthenticated', 'bearer token is required', { type: 'audit.missing_token' }));
}

/** An organization's own audit trail, for its owners and admins. */
@RateLimit(perClient('audit', 120, 60_000))
@Controller('organizations/:organizationId/audit')
export class OrganizationAuditController {
  constructor(private readonly list: ListOrganizationAuditEntries) {}

  /** One page of entries; `X-Next-Cursor` carries the cursor for the next. */
  @Get('entries')
  async entries(
    @Param('organizationId') organizationIdValue: string,
    @Res({ passthrough: true }) response: Response,
    @Headers('authorization') authorization?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const organizationId = respond(parse(organizationIdValue));
    const sessionToken = respond(bearer(authorization));
    const page = respond(
      await this.list.execute({ sessionToken, organizationId, limit, cursor }),
    );
    if (page.nextCursor) response.setHeader('X-Next-Cursor', page.nextCursor);
    return page.items.map((entry) => ({
      auditEntryId: entry.auditEntryId,
      eventId: entry.eventId,
      eventType: entry.eventType,
      occurredAt: entry.occurredAt.toISOString(),
      recordedAt: entry.recordedAt.toISOString(),
      workId: entry.workId,
      correlationId: entry.correlationId,
      operation: entry.operation,
      initiator: entry.initiator,
      subject: entry.subject,
    }));
  }
}
