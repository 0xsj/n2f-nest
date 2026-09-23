import {
  ok,
  type Result,
} from '../../../../shared/errors/index.js';
import type { Actor } from '../../../../shared/provenance/index.js';
import type { AuditEntry } from '../../domain/index.js';
import type { AuditEntryReader } from '../ports/index.js';
import { dependencyFailure, type AuditApplicationFailure } from '../failures.js';

export type AuditEntryView = Readonly<{
  auditEntryId: AuditEntry['id'];
  eventId: AuditEntry['eventId'];
  eventType: string;
  occurredAt: Date;
  recordedAt: Date;
  workId: AuditEntry['provenance']['workId'];
  correlationId: AuditEntry['provenance']['correlationId'];
  operation: AuditEntry['provenance']['operation'];
  initiator: Actor | null;
  subject: AuditEntry['subject'];
}>;

export type ListAuditEntriesDependencies = Readonly<{
  reader: AuditEntryReader;
}>;

export function view(entry: AuditEntry): AuditEntryView {
  const work = entry.provenance;
  return {
    auditEntryId: entry.id,
    eventId: entry.eventId,
    eventType: entry.eventType,
    occurredAt: entry.occurredAt,
    recordedAt: entry.recordedAt,
    workId: work.workId,
    correlationId: work.correlationId,
    operation: work.operation,
    initiator: work.attribution.initiator ?? null,
    subject: entry.subject,
  };
}

export class ListAuditEntries {
  constructor(
    private readonly dependencies: ListAuditEntriesDependencies,
  ) {}

  async execute(signal?: AbortSignal): Promise<Result<readonly AuditEntryView[], AuditApplicationFailure>> {
    const entries = await this.dependencies.reader.list(signal);
    return entries.ok
      ? ok(entries.value.map(view))
      : { ok: false, error: dependencyFailure(entries.error, 'audit.list') };
  }
}
