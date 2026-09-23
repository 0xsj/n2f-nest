import {
  err,
  ok,
  type Result,
} from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import type { WallClock } from '../../../../shared/clock/index.js';
import type { ID, IDGenerator } from '../../../../shared/id/index.js';
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

export class RecordAuditEvent {
  constructor(
    private readonly dependencies: RecordAuditEventDependencies,
  ) {}

  async execute(
    command: RecordAuditEventCommand,
  ): Promise<Result<RecordAuditEventResult, AuditApplicationFailure>> {
    // The producing module names the subject on the envelope; Audit never
    // interprets another module's payload.
    const subject: AuditSubject | null = command.event.subject
      ? { kind: command.event.subject.kind, id: command.event.subject.id }
      : null;

    const id = this.dependencies.ids.newId();
    if (!id.ok) return err(idGenerationFailure(id.error));

    const entry = AuditEntryModel.record({
      id: id.value,
      eventId: command.event.id,
      eventType: command.event.type,
      occurredAt: new Date(command.event.occurredAtMs),
      recordedAt: this.dependencies.clock.now(),
      work: command.event.work,
      subject,
      tenant: command.event.tenant ?? null,
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
