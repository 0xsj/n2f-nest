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
import {
  Identity,
  Session,
  VerificationChallenge,
} from '../../domain/index.js';
import type { TransactionDatabase } from './database.js';
import { PostgresVerificationWriter } from './verification-writer.js';
import {
  PostgresCurrentSessionReader,
  PostgresSessionRevocationWriter,
  PostgresSessionWriter,
} from './sessions.js';
import { digestToken } from '../in-memory/crypto.js';

const ids = [
  '00000000-0000-7000-8000-000000000001',
  '00000000-0000-7000-8000-000000000002',
  '00000000-0000-7000-8000-000000000003',
  '00000000-0000-7000-8000-000000000004',
].map((value) => parse(value));

if (ids.some((result) => !result.ok)) {
  throw new Error('test IDs should be valid');
}

const [identityId, challengeId, sessionId, eventId] = ids.map((result) => {
  if (!result.ok) throw new Error('test ID should be valid');
  return result.value;
});

const createdAt = new Date('2026-09-19T00:00:00.000Z');
const expiresAt = new Date('2026-09-20T00:00:00.000Z');
const consumedAt = new Date('2026-09-19T00:30:00.000Z');

function workContext() {
  const result = restoreWork({
    workId: identityId,
    correlationId: eventId,
    correlationSource: 'local',
    operation: operation('identity.verify').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'request',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

class QueryClient {
  readonly queries: string[] = [];

  async query(text: string) {
    this.queries.push(text);
    return {
      rowCount: text.trimStart().startsWith('SELECT') ? 0 : 1,
      rows: [],
    };
  }
}

class DatabaseSpy implements TransactionDatabase {
  readonly client = new QueryClient();

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

describe('PostgresVerificationWriter', () => {
  it('updates Identity and consumes the challenge before enqueueing', async () => {
    const identity = Identity.register({ id: identityId, createdAt });
    if (!identity.ok) throw new Error(identity.error.message);
    const challenge = VerificationChallenge.issue({
      id: challengeId,
      identityId,
      purpose: 'email_verification',
      issuedAt: createdAt,
      expiresAt,
    });
    if (!challenge.ok) throw new Error(challenge.error.message);
    const verified = identity.value.verify(consumedAt);
    const consumed = challenge.value.consume(consumedAt);
    if (!verified.ok || !consumed.ok) throw new Error('test transition failed');

    const event = Envelope.create(
      eventId,
      'identity.verified.v1',
      consumedAt.getTime(),
      workContext(),
      { identity_id: identityId, challenge_id: challengeId, status: 'active' },
    );
    if (!event.ok) throw new Error(event.error.message);

    const database = new DatabaseSpy();
    const result = await new PostgresVerificationWriter(database).commit({
      identity: verified.value,
      challenge: consumed.value,
      event: event.value,
      work: workContext(),
    });

    expect(result).toEqual(ok(undefined));
    expect(database.client.queries).toHaveLength(3);
    expect(database.client.queries[0]).toContain('UPDATE public.n2f_identity_identities');
    expect(database.client.queries[1]).toContain(
      'UPDATE public.n2f_identity_verification_challenges',
    );
    expect(database.client.queries[2]).toContain('n2f_outbox');
  });
});

describe('PostgreSQL session adapters', () => {
  function session() {
    const result = Session.create({
      id: sessionId,
      identityId,
      createdAt,
      expiresAt,
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  function event(type: string) {
    const result = Envelope.create(
      eventId,
      type,
      createdAt.getTime(),
      workContext(),
      { identity_id: identityId, session_id: sessionId },
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  it('persists a session and its outbox event together', async () => {
    const database = new DatabaseSpy();
    const result = await new PostgresSessionWriter(database).commit({
      session: session(),
      tokenDigest: digestToken(new SecretString('session-token')),
      event: event('identity.session.created.v1'),
      work: workContext(),
    });

    expect(result).toEqual(ok(undefined));
    expect(database.client.queries).toHaveLength(2);
    expect(database.client.queries[0]).toContain('n2f_identity_sessions');
    expect(database.client.queries[1]).toContain('n2f_outbox');
  });

  it('rehydrates a session by digest without querying raw token material', async () => {
    const database = new DatabaseSpy();
    const row = {
      id: sessionId,
      identity_id: identityId,
      status: 'active',
      created_at: createdAt,
      expires_at: expiresAt,
      revoked_at: null,
    };
    database.client.query = async (text: string) => {
      database.client.queries.push(text);
      return { rowCount: 1, rows: [row] };
    };

    const result = await new PostgresCurrentSessionReader(database).findByToken(
      new SecretString('session-token'),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.id).toBe(sessionId);
    expect(database.client.queries[0]).toContain('token_digest=$1');
  });

  it('updates revocation state before enqueueing the revocation event', async () => {
    const revoked = session().revoke(new Date('2026-09-19T01:00:00.000Z'));
    if (!revoked.ok) throw new Error(revoked.error.message);
    const database = new DatabaseSpy();
    const result = await new PostgresSessionRevocationWriter(database).commit({
      session: revoked.value,
      event: event('identity.session.revoked.v1'),
      work: workContext(),
    });

    expect(result).toEqual(ok(undefined));
    expect(database.client.queries).toHaveLength(2);
    expect(database.client.queries[0]).toContain(
      'UPDATE public.n2f_identity_sessions',
    );
    expect(database.client.queries[1]).toContain('n2f_outbox');
  });
});
