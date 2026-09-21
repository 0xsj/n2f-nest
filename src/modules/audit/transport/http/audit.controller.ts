import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import {
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
  constructor(private readonly list: ListAuditEntries) {}

  @Get('entries')
  async entries() {
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
