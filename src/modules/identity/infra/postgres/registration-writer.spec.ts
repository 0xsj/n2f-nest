import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import { parse } from '../../../../shared/id/index.js';
import {
  anonymous,
  attribution,
  operation,
  restoreWork,
} from '../../../../shared/provenance/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import { Credential, Identity } from '../../domain/index.js';
import {
  PostgresRegistrationWriter,
  type TransactionDatabase,
} from './registration-writer.js';

const ids = [
  '00000000-0000-7000-8000-000000000001',
  '00000000-0000-7000-8000-000000000002',
  '00000000-0000-7000-8000-000000000003',
  '00000000-0000-7000-8000-000000000004',
].map((value) => parse(value));

if (ids.some((result) => !result.ok)) {
  throw new Error('test IDs should be valid');
}

const validIds = ids.map((result) => {
  if (!result.ok) throw new Error('test ID should be valid');
  return result.value;
});

function workContext() {
  const result = restoreWork({
    workId: validIds[0]!,
    correlationId: validIds[1]!,
    correlationSource: 'local',
    operation: operation('identity.register').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'request',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function input() {
  const createdAt = new Date('2026-09-19T00:00:00.000Z');
  const identity = Identity.register({
    id: validIds[2]!,
    createdAt,
  });
  if (!identity.ok) throw new Error(identity.error.message);

  const credential = Credential.createEmailPassword({
    id: validIds[3]!,
    identityId: identity.value.id,
    email: 'artist@example.com',
    createdAt,
  });
  if (!credential.ok) throw new Error(credential.error.message);

  const work = workContext();
  const event = Envelope.create(
    validIds[0]!,
    'identity.registered.v1',
    createdAt.getTime(),
    work,
    { identity_id: identity.value.id, credential_id: credential.value.id },
  );
  if (!event.ok) throw new Error(event.error.message);

  return {
    identity: identity.value,
    credential: credential.value,
    passwordHash: new SecretString('scrypt-v1$test$hash'),
    event: event.value,
    work,
  };
}

type Query = { text: string; values?: readonly unknown[] };

class QueryClient {
  readonly queries: Query[] = [];

  async query(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, values });
    return { rowCount: 1, rows: [] };
  }
}

class DatabaseSpy implements TransactionDatabase {
  readonly client = new QueryClient();
  readonly databaseSignal = new AbortController().signal;

  async transaction<T>(
    fn: (
      transaction: pg.PoolClient,
      signal: AbortSignal,
    ) => Promise<Result<T, Failure>>,
  ): Promise<Result<T, Failure>> {
    return fn(
      this.client as unknown as pg.PoolClient,
      this.databaseSignal,
    );
  }
}

describe('PostgresRegistrationWriter', () => {
  it('inserts state before enqueueing the matching outbox event', async () => {
    const database = new DatabaseSpy();
    const result = await new PostgresRegistrationWriter(database).commit(input());

    expect(result).toEqual(ok(undefined));
    expect(database.client.queries).toHaveLength(3);
    expect(database.client.queries[0]?.text).toContain(
      'signals_identity_identities',
    );
    expect(database.client.queries[1]?.text).toContain(
      'signals_identity_credentials',
    );
    expect(database.client.queries[1]?.values).toContain('scrypt-v1$test$hash');
    expect(database.client.queries[2]?.text).toContain('signals_outbox');
  });

  it('rejects an event whose provenance does not match the write', async () => {
    const database = new DatabaseSpy();
    const registration = input();
    const otherWork = restoreWork({
      workId: validIds[3]!,
      correlationId: validIds[2]!,
      correlationSource: 'local',
      operation: operation('identity.register').value,
      attribution: attribution({ initiator: anonymous() }).value,
      origin: 'request',
    });
    if (!otherWork.ok) throw new Error(otherWork.error.message);

    const result = await new PostgresRegistrationWriter(database).commit({
      ...registration,
      work: otherWork.value,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('events.provenance_mismatch');
    expect(database.client.queries).toHaveLength(0);
  });

  it('maps a database exception to a safe failure', async () => {
    const database: TransactionDatabase = {
      transaction: async (fn) => {
        const client = {
          query: async () => {
            throw new Error('connection details must not escape');
          },
        } as unknown as pg.PoolClient;
        return fn(client, new AbortController().signal);
      },
    };

    const result = await new PostgresRegistrationWriter(database).commit(input());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('unavailable');
  });
});
