import {
  err,
  ok,
  typedFailure,
  type TypedFailure,
  type Result,
} from '../../../shared/errors/index.js';
import type { ID } from '../../../shared/id/index.js';
import type {
  Actor,
  WorkContext,
  WorkSnapshot,
} from '../../../shared/provenance/index.js';
import { restoreWork } from '../../../shared/provenance/index.js';

export type AuditSubject = Readonly<{
  kind: string;
  id: ID;
}>;

export type RecordAuditEntryInput = Readonly<{
  id: ID;
  eventId: ID;
  eventType: string;
  occurredAt: Date;
  recordedAt: Date;
  work: WorkContext;
  subject: AuditSubject | null;
  /** The organization the audited event belongs to, if any. */
  tenant: ID | null;
}>;

export type RestoreAuditEntryInput = Readonly<{
  id: ID;
  eventId: ID;
  eventType: string;
  occurredAt: Date;
  recordedAt: Date;
  work: WorkSnapshot;
  subject: AuditSubject | null;
  /** The organization the audited event belongs to, if any. */
  tenant: ID | null;
}>;

export type AuditEntryFailureType =
  | 'audit.invalid_time'
  | 'audit.invalid_event_type'
  | 'audit.invalid_subject'
  | 'audit.invalid_provenance';

export type AuditEntryFailure = TypedFailure<'invalid', AuditEntryFailureType>;

type AuditEntryState = Readonly<{
  id: ID;
  eventId: ID;
  eventType: string;
  occurredAt: Date;
  recordedAt: Date;
  work: WorkSnapshot;
  subject: AuditSubject | null;
  /** The organization the audited event belongs to, if any. */
  tenant: ID | null;
}>;

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function copyDate(value: Date): Date {
  return new Date(value.getTime());
}

function copyActor(actor: Actor | undefined): Actor | undefined {
  return actor === undefined ? undefined : Object.freeze({ ...actor });
}

function copyWork(work: WorkSnapshot): WorkSnapshot {
  return Object.freeze({
    ...work,
    attribution: Object.freeze({
      initiator: copyActor(work.attribution.initiator),
      onBehalfOf: copyActor(work.attribution.onBehalfOf),
      tenant: work.attribution.tenant,
    }),
    causation:
      work.causation === undefined
        ? undefined
        : Object.freeze({ ...work.causation }),
    replay:
      work.replay === undefined
        ? undefined
        : Object.freeze({
            ...work.replay,
            source: Object.freeze({ ...work.replay.source }),
          }),
  });
}

function invalid(
  message: string,
  type: AuditEntryFailureType,
): AuditEntryFailure {
  return typedFailure('invalid', type, message);
}

export class AuditEntry {
  private constructor(private readonly state: AuditEntryState) {
    Object.freeze(this.state);
  }

  static record(
    input: RecordAuditEntryInput,
  ): Result<AuditEntry, AuditEntryFailure> {
    if (!validDate(input.occurredAt) || !validDate(input.recordedAt)) {
      return err(invalid('audit times must be valid', 'audit.invalid_time'));
    }

    if (
      typeof input.eventType !== 'string' ||
      !/^[a-z0-9_.-]{1,120}\.v[1-9][0-9]{0,5}$/.test(input.eventType)
    ) {
      return err(
        invalid('audit event type is invalid', 'audit.invalid_event_type'),
      );
    }

    if (
      input.subject !== null &&
      (typeof input.subject.kind !== 'string' ||
        !/^[a-z][a-z0-9_.-]{0,63}$/.test(input.subject.kind))
    ) {
      return err(invalid('audit subject is invalid', 'audit.invalid_subject'));
    }

    const work = copyWork(input.work.snapshot());
    return ok(
      new AuditEntry({
        id: input.id,
        eventId: input.eventId,
        eventType: input.eventType,
        occurredAt: copyDate(input.occurredAt),
        recordedAt: copyDate(input.recordedAt),
        work,
        subject:
          input.subject === null ? null : Object.freeze({ ...input.subject }),
        tenant: input.tenant ?? null,
      }),
    );
  }

  static restore(
    input: RestoreAuditEntryInput,
  ): Result<AuditEntry, AuditEntryFailure> {
    const work = restoreWork(input.work);
    if (!work.ok) {
      return err(
        typedFailure(
          'invalid',
          'audit.invalid_provenance',
          'audit provenance is invalid',
          { cause: work.error },
        ),
      );
    }
    return AuditEntry.record({ ...input, work: work.value });
  }

  get id(): ID {
    return this.state.id;
  }

  get eventId(): ID {
    return this.state.eventId;
  }

  get eventType(): string {
    return this.state.eventType;
  }

  get occurredAt(): Date {
    return copyDate(this.state.occurredAt);
  }

  get recordedAt(): Date {
    return copyDate(this.state.recordedAt);
  }

  get provenance(): WorkSnapshot {
    return copyWork(this.state.work);
  }

  get tenant(): ID | null {
    return this.state.tenant;
  }

  get subject(): AuditSubject | null {
    return this.state.subject === null ? null : { ...this.state.subject };
  }
}
