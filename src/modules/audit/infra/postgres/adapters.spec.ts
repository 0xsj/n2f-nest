import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import { parse } from '../../../../shared/id/index.js';
import {
  anonymous,
  attribution,
  operation,
  restoreWork,
} from '../../../../shared/provenance/index.js';
import type { TransactionDatabase } from '../../../../shared/postgres/index.js';
import {
  AuditEntry,
  type AuditSubject,
} from '../../domain/index.js';
import { encodeWork } from './codec.js';
import {
  PostgresAuditEntryReader,
  PostgresAuditEntryWriter,
} from './adapters.js';

const ids = [
  '00000000-0000-7000-8000-000000000001',
  '00000000-0000-7000-8000-000000000002',
  '00000000-0000-7000-8000-000000000003',
].map((value) => parse(value));

if (ids.some((result) => !result.ok)) {
  throw new Error('test IDs should be valid');
}

const [entryId, eventId, subjectId] = ids.map((result) => {
  if (!result.ok) throw new Error('test ID should be valid');
  return result.value;
});

const occurredAt = new Date('2026-09-19T00:00:00.000Z');
const recordedAt = new Date('2026-09-19T00:00:01.000Z');

function work() {
  const result = restoreWork({
    workId: entryId,
    correlationId: eventId,
    correlationSource: 'local',
    operation: operation('identity.register').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'request',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function entry() {
  const subject: AuditSubject = { kind: 'identity', id: subjectId };
  const result = AuditEntry.record({
    id: entryId,
    eventId,
    eventType: 'identity.registered.v1',
    occurredAt,
    recordedAt,
    tenant: null,
    work: work(),
    subject,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

type QueryResult = { rowCount: number; rows: unknown[] };

class QueryClient {
  readonly queries: string[] = [];

  constructor(private readonly duplicate: boolean) {}

  async query(text: string): Promise<QueryResult> {
    this.queries.push(text);
    if (text.trimStart().startsWith('SELECT')) {
      return this.duplicate
        ? { rowCount: 1, rows: [auditRow()] }
        : { rowCount: 0, rows: [] };
    }
    return { rowCount: this.duplicate ? 0 : 1, rows: [] };
  }
}

class DatabaseSpy implements TransactionDatabase {
  readonly client: QueryClient;

  constructor(duplicate = false) {
    this.client = new QueryClient(duplicate);
  }

  async transaction<T>(
    fn: (
      transaction: pg.PoolClient,
      signal: AbortSignal,
    ) => Promise<Result<T, Failure>>,
  ): Promise<Result<T, Failure>> {
    return fn(
      this.client as unknown as pg.PoolClient,
      new AbortController().signal,
    );
  }
}

function auditRow() {
  const value = entry();
  return {
    id: value.id,
    event_id: value.eventId,
    event_type: value.eventType,
    occurred_at: value.occurredAt,
    recorded_at: value.recordedAt,
    work_context: encodeWork(value.provenance),
    subject_kind: value.subject?.kind ?? null,
    subject_id: value.subject?.id ?? null,
    tenant_id: value.tenant,
  };
}

describe('PostgreSQL Audit adapters', () => {
  it('records event metadata and provenance without an event payload', async () => {
    const database = new DatabaseSpy();
    const result = await new PostgresAuditEntryWriter(database).record(entry());

    expect(result).toEqual(ok({ entry: entry(), created: true }));
    expect(database.client.queries).toHaveLength(1);
    expect(database.client.queries[0]).toContain('n2f_audit_entries');
  });

  it('returns the existing entry when the source event is delivered again', async () => {
    const database = new DatabaseSpy(true);
    const result = await new PostgresAuditEntryWriter(database).record(entry());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.created).toBe(false);
      expect(result.value.entry.eventId).toBe(eventId);
      expect(result.value.entry.provenance.operation).toBe('identity.register');
    }
    expect(database.client.queries).toHaveLength(2);
  });

  it('rehydrates the ordered Audit read model', async () => {
    const database = new DatabaseSpy(true);
    const result = await new PostgresAuditEntryReader(database).list();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.subject).toEqual({
        kind: 'identity',
        id: subjectId,
      });
      expect(result.value[0]?.provenance.operation).toBe('identity.register');
    }
  });

  it('maps database failures to safe Result values', async () => {
    const database: TransactionDatabase = {
      transaction: async (fn) =>
        fn(
          {
            query: async () => {
              throw new Error('connection details must not escape');
            },
          } as unknown as pg.PoolClient,
          new AbortController().signal,
        ),
    };

    const result = await new PostgresAuditEntryReader(database).list();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('unavailable');
  });
});
