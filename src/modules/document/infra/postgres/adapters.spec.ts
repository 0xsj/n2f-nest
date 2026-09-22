import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import {
  anonymous,
  attribution,
  operation,
  restoreWork,
} from '../../../../shared/provenance/index.js';
import { type TransactionDatabase } from '../../../../shared/postgres/index.js';
import { Document } from '../../domain/index.js';
import { PostgresDocumentReader } from './reader.js';
import { PostgresDocumentWriter } from './writer.js';

function id(value: string): ID {
  const result = parse(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function work(workId = id('00000000-0000-7000-8000-000000000011')) {
  const result = restoreWork({
    workId,
    correlationId: id('00000000-0000-7000-8000-000000000012'),
    correlationSource: 'local',
    operation: operation('document.create').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'request',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function documentFixture() {
  const result = Document.create({
    id: id('00000000-0000-7000-8000-000000000013'),
    organizationId: id('00000000-0000-7000-8000-000000000014'),
    name: 'postgres contract document',
    storageKey: 'documents/postgres.txt',
    createdAt: new Date('2026-09-22T00:00:00.000Z'),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function event(document: Document, context = work()) {
  const result = Envelope.create(
    id('00000000-0000-7000-8000-000000000015'),
    'document.created.v1',
    document.createdAt.getTime(),
    context,
    { document_id: document.id, organization_id: document.organizationId },
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

type Query = { readonly text: string; readonly values?: readonly unknown[] };

class QueryClient {
  readonly queries: Query[] = [];

  constructor(private readonly rows: readonly unknown[] = []) {}

  async query<T>(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, values });
    return { rowCount: 1, rows: this.rows as T[] };
  }
}

class DatabaseSpy implements TransactionDatabase {
  readonly client: QueryClient;

  constructor(rows: readonly unknown[] = []) {
    this.client = new QueryClient(rows);
  }

  transaction<T>(
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

describe('Document PostgreSQL adapter contract', () => {
  it('writes document state before enqueueing its matching event', async () => {
    const database = new DatabaseSpy();
    const document = documentFixture();
    const result = await new PostgresDocumentWriter(database).commit({
      mode: 'create',
      document,
      event: event(document),
      work: work(),
    });

    expect(result).toEqual(ok(undefined));
    expect(database.client.queries).toHaveLength(2);
    expect(database.client.queries[0]?.text).toContain(
      'n2f_document_documents',
    );
    expect(database.client.queries[1]?.text).toContain('n2f_outbox');
  });

  it('rejects an event whose provenance does not match the write', async () => {
    const database = new DatabaseSpy();
    const document = documentFixture();
    const eventWork = work();
    const result = await new PostgresDocumentWriter(database).commit({
      mode: 'create',
      document,
      event: event(document, eventWork),
      work: work(id('00000000-0000-7000-8000-000000000016')),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('events.provenance_mismatch');
    expect(database.client.queries).toHaveLength(0);
  });

  it('rehydrates rows through Document.restore', async () => {
    const document = documentFixture();
    const database = new DatabaseSpy([
      {
        document_id: document.id,
        organization_id: document.organizationId,
        name: document.name,
        storage_key: document.storageKey,
        status: document.status,
        processing_failure_code: document.processingFailureCode,
        created_at: document.createdAt,
        updated_at: document.updatedAt,
        archived_at: document.archivedAt,
      },
    ]);

    const result = await new PostgresDocumentReader(database).findById(document.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value?.id).toBe(document.id);
      expect(result.value?.storageKey).toBe('documents/postgres.txt');
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

    const result = await new PostgresDocumentReader(database).findById(
      id('00000000-0000-7000-8000-000000000013'),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('unavailable');
  });
});
