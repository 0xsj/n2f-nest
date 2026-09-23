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
import { VerificationChallenge, normalizeEmail } from '../../domain/index.js';
import type { TransactionDatabase } from './database.js';
import {
  PostgresCredentialAuthenticatorReader,
  PostgresIdentityReader,
  PostgresIdentityViewReader,
  PostgresVerificationChallengeReader,
} from './readers.js';
import { PostgresVerificationChallengeWriter } from './challenge-writer.js';

const ids = [
  '00000000-0000-7000-8000-000000000001',
  '00000000-0000-7000-8000-000000000002',
  '00000000-0000-7000-8000-000000000003',
].map((value) => parse(value));

if (ids.some((result) => !result.ok)) {
  throw new Error('test IDs should be valid');
}

const [identityId, credentialId, challengeId] = ids.map((result) => {
  if (!result.ok) throw new Error('test ID should be valid');
  return result.value;
});

const issuedAt = new Date('2026-09-19T00:00:00.000Z');
const expiresAt = new Date('2026-09-19T01:00:00.000Z');

function workContext() {
  const result = restoreWork({
    workId: identityId,
    correlationId: credentialId,
    correlationSource: 'local',
    operation: operation('identity.challenge.issue').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'request',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

class QueryClient {
  readonly queries: string[] = [];

  constructor(private readonly rows: unknown[]) {}

  async query(text: string) {
    this.queries.push(text);
    return {
      rowCount: text.trimStart().startsWith('SELECT') ? this.rows.length : 1,
      rows: this.rows,
    };
  }
}

class DatabaseSpy implements TransactionDatabase {
  readonly client: QueryClient;

  constructor(rows: unknown[]) {
    this.client = new QueryClient(rows);
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

function identityRow() {
  return {
    id: identityId,
    status: 'pending_verification',
    created_at: issuedAt,
    updated_at: issuedAt,
    verified_at: null,
    version: 1,
  };
}

function credentialRow() {
  return {
    ...identityRow(),
    credential_id: credentialId,
    credential_identity_id: identityId,
    credential_method: 'email_password',
    credential_email: 'artist@example.com',
    credential_status: 'active',
    password_hash: 'scrypt-v1$test$hash',
    credential_created_at: issuedAt,
    credential_updated_at: issuedAt,
    credential_revoked_at: null,
  };
}

function challengeRow() {
  return {
    id: challengeId,
    identity_id: identityId,
    purpose: 'email_verification',
    status: 'issued',
    issued_at: issuedAt,
    expires_at: expiresAt,
    consumed_at: null,
    token_digest: 'digest',
    version: 1,
  };
}

describe('Postgres Identity readers', () => {
  it('rehydrates the Identity domain object', async () => {
    const result = await new PostgresIdentityReader(
      new DatabaseSpy([identityRow()]),
    ).find(identityId);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value?.id).toBe(identityId);
      expect(result.value?.status).toBe('pending_verification');
    }
  });

  it('projects a safe current-identity view', async () => {
    const result = await new PostgresIdentityViewReader(
      new DatabaseSpy([identityRow()]),
    ).findById(identityId);

    expect(result).toEqual(
      ok({
        identityId,
        status: 'pending_verification',
        verifiedAt: null,
      }),
    );
  });

  it('rehydrates credentials and keeps the password hash secret', async () => {
    const email = normalizeEmail('artist@example.com');
    if (!email.ok) throw new Error(email.error.message);
    const result = await new PostgresCredentialAuthenticatorReader(
      new DatabaseSpy([credentialRow()]),
    ).findByEmail(email.value);

    expect(result.ok).toBe(true);
    if (result.ok && result.value) {
      expect(result.value.credential.email).toBe('artist@example.com');
      expect(result.value.passwordHash).toBeInstanceOf(SecretString);
      expect(result.value.passwordHash.toString()).toBe('[REDACTED]');
      expect(result.value.passwordHash.reveal()).toBe('scrypt-v1$test$hash');
    }
  });

  it('rehydrates verification challenges without exposing their digest', async () => {
    const result = await new PostgresVerificationChallengeReader(
      new DatabaseSpy([challengeRow()]),
    ).find(challengeId);

    expect(result.ok).toBe(true);
    if (result.ok && result.value) {
      expect(result.value.challenge.id).toBe(challengeId);
      expect(result.value.challenge.status).toBe('issued');
      expect(result.value.tokenDigest.toString()).toBe('[REDACTED]');
    }
  });
});

describe('PostgresVerificationChallengeWriter', () => {
  it('persists the challenge before enqueueing its event', async () => {
    const challenge = VerificationChallenge.issue({
      id: challengeId,
      identityId,
      purpose: 'email_verification',
      issuedAt,
      expiresAt,
    });
    if (!challenge.ok) throw new Error(challenge.error.message);

    const event = Envelope.create(
      credentialId,
      'identity.verification.challenge.issued.v1',
      issuedAt.getTime(),
      workContext(),
      { identity_id: identityId, challenge_id: challengeId },
    );
    if (!event.ok) throw new Error(event.error.message);

    const database = new DatabaseSpy([]);
    const result = await new PostgresVerificationChallengeWriter(database).commit({
      challenge: challenge.value,
      tokenDigest: new SecretString('digest'),
      event: event.value,
      work: workContext(),
    });

    expect(result).toEqual(ok(undefined));
    expect(database.client.queries).toHaveLength(2);
    expect(database.client.queries[0]).toContain(
      'n2f_identity_verification_challenges',
    );
    expect(database.client.queries[1]).toContain('n2f_outbox');
  });
});
