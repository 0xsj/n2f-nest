import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type { After } from '../../../../shared/pagination/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import { map, type TransactionDatabase } from '../../../../shared/postgres/index.js';
import type {
  AuditEntryReader,
  AuditEntryWriter,
  AuditWriteResult,
} from '../../app/ports/index.js';
import { AuditEntry, type AuditSubject } from '../../domain/index.js';
import { decodeWork, encodeWork } from './codec.js';

type AuditRow = {
  id: string;
  event_id: string;
  event_type: string;
  occurred_at: Date;
  recorded_at: Date;
  work_context: unknown;
  subject_kind: string | null;
  subject_id: string | null;
  tenant_id: string | null;
};

function id(value: unknown): Result<ID, Failure> {
  if (typeof value !== 'string') {
    return err(
      failure('internal', 'stored audit ID is invalid', {
        type: 'audit.persistence_invalid',
      }),
    );
  }
  return parse(value);
}

function entryFrom(row: AuditRow): Result<AuditEntry, Failure> {
  const entryId = id(row.id);
  const eventId = id(row.event_id);
  const work = decodeWork(row.work_context);
  if (!entryId.ok || !eventId.ok || !work.ok) {
    return err(
      failure('internal', 'stored audit entry is invalid', {
        type: 'audit.persistence_invalid',
      }),
    );
  }

  let subject: AuditSubject | null = null;
  if (row.subject_kind !== null || row.subject_id !== null) {
    const subjectId = id(row.subject_id);
    if (row.subject_kind === null || !subjectId.ok) {
      return err(
        failure('internal', 'stored audit subject is invalid', {
          type: 'audit.persistence_invalid',
        }),
      );
    }
    subject = { kind: row.subject_kind, id: subjectId.value };
  }

  const tenant = row.tenant_id === null ? null : id(row.tenant_id);
  if (tenant !== null && !tenant.ok) {
    return err(
      failure('internal', 'stored audit tenant is invalid', {
        type: 'audit.persistence_invalid',
      }),
    );
  }

  return AuditEntry.restore({
    id: entryId.value,
    eventId: eventId.value,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    work: work.value.snapshot(),
    subject,
    tenant: tenant === null ? null : tenant.value,
  });
}

const COLUMNS = `id,event_id,event_type,occurred_at,recorded_at,
    work_context,subject_kind,subject_id,tenant_id`;

const selectByEvent = `SELECT ${COLUMNS} FROM public.n2f_audit_entries WHERE event_id=$1::uuid`;

/** The development listing is bounded to the newest entries. */
const DEVELOPMENT_LIST_LIMIT = 1000;

export class PostgresAuditEntryWriter implements AuditEntryWriter {
  constructor(private readonly database: TransactionDatabase) {}

  record(
    entry: AuditEntry,
    signal?: AbortSignal,
  ): Promise<Result<AuditWriteResult, Failure>> {
    return this.database.transaction<AuditWriteResult>(async (transaction) => {
      try {
        const subject = entry.subject;
        const inserted = await transaction.query(
          `INSERT INTO public.n2f_audit_entries
            (id,event_id,event_type,occurred_at,recorded_at,work_context,subject_kind,subject_id,tenant_id)
           VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7,$8::uuid,$9::uuid)
           ON CONFLICT (event_id) DO NOTHING`,
          [
            entry.id,
            entry.eventId,
            entry.eventType,
            entry.occurredAt,
            entry.recordedAt,
            JSON.stringify(encodeWork(entry.provenance)),
            subject?.kind ?? null,
            subject?.id ?? null,
            entry.tenant,
          ],
        );
        if (inserted.rowCount === 1) return ok({ entry, created: true });

        const existing = await transaction.query<AuditRow>(selectByEvent, [
          entry.eventId,
        ]);
        const row = existing.rows[0];
        if (!row) {
          return err(
            failure('conflict', 'audit event identity was reused', {
              type: 'audit.event_id_reused',
            }),
          );
        }
        const restored = entryFrom(row);
        return restored.ok
          ? ok({ entry: restored.value, created: false })
          : restored;
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }
}

export class PostgresAuditEntryReader implements AuditEntryReader {
  constructor(private readonly database: TransactionDatabase) {}

  list(signal?: AbortSignal): Promise<Result<readonly AuditEntry[], Failure>> {
    return this.database.transaction<readonly AuditEntry[]>(async (transaction) => {
      try {
        const result = await transaction.query<AuditRow>(
          `SELECT ${COLUMNS} FROM (
             SELECT ${COLUMNS} FROM public.n2f_audit_entries
              ORDER BY recorded_at DESC,id DESC LIMIT $1) newest
            ORDER BY recorded_at,id`,
          [DEVELOPMENT_LIST_LIMIT],
        );
        const entries: AuditEntry[] = [];
        for (const row of result.rows) {
          const entry = entryFrom(row);
          if (!entry.ok) return entry;
          entries.push(entry.value);
        }
        return ok(entries);
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }

  listForTenant(
    tenant: ID,
    page: Readonly<{ limit: number; after?: After }>,
    signal?: AbortSignal,
  ): Promise<Result<readonly AuditEntry[], Failure>> {
    return this.database.transaction<readonly AuditEntry[]>(async (transaction) => {
      try {
        const result = await transaction.query<AuditRow>(
          `SELECT ${COLUMNS} FROM public.n2f_audit_entries
            WHERE tenant_id=$1::uuid
              AND ($2::timestamptz IS NULL OR (recorded_at,id) > ($2::timestamptz,$3::uuid))
            ORDER BY recorded_at,id
            LIMIT $4`,
          [tenant, page.after?.at ?? null, page.after?.id ?? null, page.limit + 1],
        );
        const entries: AuditEntry[] = [];
        for (const row of result.rows) {
          const entry = entryFrom(row);
          if (!entry.ok) return entry;
          entries.push(entry.value);
        }
        return ok(entries);
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }
}
