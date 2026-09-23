import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import {
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../../../../platform/runtime/index.js';
import {
  err,
  failure,
  publicInfo,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { problemOf } from '../../../../shared/http/index.js';
import { ListAuditEntries } from '../../app/index.js';

function respond<T>(result: Result<T, Failure>): T {
  if (result.ok) return result.value;
  const problem = problemOf(result);
  throw new HttpException(
    problem ?? { ...publicInfo(result.error) },
    problem?.status ?? HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

@Controller('audit')
export class AuditController {
  constructor(
    private readonly list: ListAuditEntries,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  /**
   * Lists every tenant's entries without authentication, so it exists only
   * for development and integration checks.
   */
  @Get('entries')
  async entries() {
    if (!this.config.http.devEndpoints) {
      respond(err(failure('not_found', 'resource not found', {
        type: 'http.not_found',
      })));
    }
    const entries = respond(await this.list.execute());
    return entries.map((entry) => ({
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
