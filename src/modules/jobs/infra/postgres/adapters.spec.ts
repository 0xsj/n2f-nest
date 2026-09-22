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
import type { TransactionDatabase } from '../../../../shared/postgres/index.js';
import { Job } from '../../domain/index.js';
import { PostgresJobReader } from './reader.js';
import { PostgresJobWriter } from './writer.js';

function id(value: string): ID {
  const result = parse(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function work(workId = id('00000000-0000-7000-8000-000000000031')) {
  const result = restoreWork({
    workId,
    correlationId: id('00000000-0000-7000-8000-000000000032'),
    correlationSource: 'local',
    operation: operation('job.submit').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'request',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function jobFixture() {
  const result = Job.create({
    id: id('00000000-0000-7000-8000-000000000033'),
    organizationId: id('00000000-0000-7000-8000-000000000034'),
    kind: 'document.process',
    subject: {
      type: 'document',
      id: id('00000000-0000-7000-8000-000000000035'),
    },
    maxAttempts: 3,
    createdAt: new Date('2026-09-22T00:00:00.000Z'),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function event(job: Job, context = work()) {
  const result = Envelope.create(
    id('00000000-0000-7000-8000-000000000036'),
    'job.submitted.v1',
    job.createdAt.getTime(),
    context,
    { job_id: job.id, organization_id: job.organizationId, kind: job.kind },
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

describe('Jobs PostgreSQL adapter contract', () => {
  it('writes job state before enqueueing its matching event', async () => {
    const database = new DatabaseSpy();
    const job = jobFixture();
    const result = await new PostgresJobWriter(database).commit({
      mode: 'create',
      job,
      event: event(job),
      work: work(),
    });

    expect(result).toEqual(ok(undefined));
    expect(database.client.queries).toHaveLength(2);
    expect(database.client.queries[0]?.text).toContain('n2f_jobs_jobs');
    expect(database.client.queries[1]?.text).toContain('n2f_outbox');
  });

  it('rejects an event whose provenance does not match the write', async () => {
    const database = new DatabaseSpy();
    const job = jobFixture();
    const eventWork = work();
    const result = await new PostgresJobWriter(database).commit({
      mode: 'create',
      job,
      event: event(job, eventWork),
      work: work(id('00000000-0000-7000-8000-000000000037')),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('events.provenance_mismatch');
    expect(database.client.queries).toHaveLength(0);
  });

  it('rehydrates rows through Job.restore, including opaque subjects', async () => {
    const job = jobFixture();
    const database = new DatabaseSpy([
      {
        job_id: job.id,
        organization_id: job.organizationId,
        kind: job.kind,
        subject_type: job.subject?.type,
        subject_id: job.subject?.id,
        status: job.status,
        attempts: job.attempts,
        max_attempts: job.maxAttempts,
        created_at: job.createdAt,
        updated_at: job.updatedAt,
        started_at: job.startedAt,
        finished_at: job.finishedAt,
        failure_code: job.failureCode,
      },
    ]);

    const result = await new PostgresJobReader(database).findById(job.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value?.id).toBe(job.id);
      expect(result.value?.subject).toEqual(job.subject);
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

    const result = await new PostgresJobReader(database).findById(
      id('00000000-0000-7000-8000-000000000033'),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('unavailable');
  });
});
