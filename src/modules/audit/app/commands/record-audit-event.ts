import {
  err,
  ok,
  typedFailure,
  type Result,
} from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import type { WallClock } from '../../../../shared/clock/index.js';
import { parse, type ID, type IDGenerator } from '../../../../shared/id/index.js';
import type { AuditSubject } from '../../domain/index.js';
import { AuditEntry as AuditEntryModel } from '../../domain/index.js';
import type { AuditEntryWriter } from '../ports/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type AuditApplicationFailure,
} from '../failures.js';

export type RecordAuditEventCommand = Readonly<{
  event: Envelope;
  signal?: AbortSignal;
}>;

export type RecordAuditEventResult = Readonly<{
  auditEntryId: ID;
  eventId: ID;
  created: boolean;
}>;

export type RecordAuditEventDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  writer: AuditEntryWriter;
}>;

function subjectOf(
  payload: Record<string, unknown>,
): Result<AuditSubject | null, AuditApplicationFailure> {
  const direct = [
    ['identity_id', 'identity'],
    ['job_id', 'job'],
    ['document_id', 'document'],
  ] as const;
  for (const [field, kind] of direct) {
    const value = payload[field];
    if (value === undefined) continue;
    const parsed = parse(value);
    if (!parsed.ok) {
      return err(
        typedFailure('invalid', 'audit.invalid_subject', `audit ${kind} subject is invalid`),
      );
    }
    return ok({ kind, id: parsed.value });
  }

  const generic = payload.subject;
  if (generic === undefined || generic === null) return ok(null);
  if (typeof generic !== 'object' || Array.isArray(generic)) {
    return err(typedFailure('invalid', 'audit.invalid_subject', 'audit subject is invalid'));
  }
  const input = generic as { type?: unknown; id?: unknown };
  if (typeof input.type !== 'string') {
    return err(typedFailure('invalid', 'audit.invalid_subject', 'audit subject is invalid'));
  }
  const parsed = parse(input.id);
  if (!parsed.ok) {
    return err(typedFailure('invalid', 'audit.invalid_subject', 'audit subject is invalid'));
  }
  return ok({ kind: input.type, id: parsed.value });
}

export class RecordAuditEvent {
  constructor(
    private readonly dependencies: RecordAuditEventDependencies,
  ) {}

  async execute(
    command: RecordAuditEventCommand,
  ): Promise<Result<RecordAuditEventResult, AuditApplicationFailure>> {
    const subject = subjectOf(command.event.payload());
    if (!subject.ok) return subject;

    const id = this.dependencies.ids.newId();
    if (!id.ok) return err(idGenerationFailure(id.error));

    const entry = AuditEntryModel.record({
      id: id.value,
      eventId: command.event.id,
      eventType: command.event.type,
      occurredAt: new Date(command.event.occurredAtMs),
      recordedAt: this.dependencies.clock.now(),
      work: command.event.work,
      subject: subject.value,
    });
    if (!entry.ok) return entry;

    const recorded = await this.dependencies.writer.record(
      entry.value,
      command.signal,
    );
    if (!recorded.ok) {
      return err(dependencyFailure(recorded.error, 'audit.record'));
    }

    return ok({
      auditEntryId: recorded.value.entry.id,
      eventId: recorded.value.entry.eventId,
      created: recorded.value.created,
    });
  }
}
