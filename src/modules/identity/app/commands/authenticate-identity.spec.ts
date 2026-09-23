import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../../shared/clock/index.js';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import { parse, type ID, type IDGenerator } from '../../../../shared/id/index.js';
import {
  anonymous,
  attribution,
  operation,
  restoreWork,
} from '../../../../shared/provenance/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import {
  Credential,
  Identity,
  Session,
} from '../../domain/index.js';
import {
  AuthenticateIdentity,
  type AuthenticateIdentityCommand,
} from './authenticate-identity.js';
import type {
  ActiveSessionReader,
  CredentialAuthenticatorReader,
  PasswordVerifier,
  SessionEviction,
  SessionPolicy,
  SessionTokenIssuer,
  SessionWriter,
} from '../ports/index.js';

const HOUR = 60 * 60 * 1000;

/** A stored, active session of the test identity created `hoursAgo` before login. */
function priorSession(id: ID, hoursAgo: number, lastSeenHoursAgo = hoursAgo): Session {
  const result = Session.restore({
    id,
    identityId: validIds[0]!,
    status: 'active',
    createdAt: new Date(createdAt.getTime() - hoursAgo * HOUR),
    expiresAt: new Date(createdAt.getTime() - hoursAgo * HOUR + 24 * HOUR),
    lastSeenAt: new Date(createdAt.getTime() - lastSeenHoursAgo * HOUR),
    revokedAt: null,
    version: 1,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const parsedIds = [
  '00000000-0000-7000-8000-000000000001',
  '00000000-0000-7000-8000-000000000002',
  '00000000-0000-7000-8000-000000000003',
  '00000000-0000-7000-8000-000000000004',
  '00000000-0000-7000-8000-000000000005',
  '00000000-0000-7000-8000-000000000006',
  '00000000-0000-7000-8000-000000000007',
  '00000000-0000-7000-8000-000000000008',
  '00000000-0000-7000-8000-000000000009',
  '00000000-0000-7000-8000-00000000000a',
  '00000000-0000-7000-8000-00000000000b',
].map((value) => parse(value));

if (parsedIds.some((result) => !result.ok)) {
  throw new Error('test IDs should be valid');
}

const validIds: ID[] = parsedIds.map((result) => {
  if (!result.ok) throw new Error('test ID should be valid');
  return result.value;
});

const createdAt = new Date('2026-09-19T00:00:00.000Z');
const expiresAt = new Date('2026-09-20T00:00:00.000Z');

class TestIds implements IDGenerator {
  private position = 3;

  newId(): Result<ID, Failure> {
    const value = validIds[this.position++];

    return value === undefined
      ? err(failure('unavailable', 'test IDs exhausted', { type: 'test.ids' }))
      : ok(value);
  }
}

function activeIdentity() {
  const registered = Identity.register({
    id: validIds[0]!,
    createdAt,
  });

  if (!registered.ok) throw new Error(registered.error.message);

  const verified = registered.value.verify(
    new Date('2026-09-19T00:01:00.000Z'),
  );

  if (!verified.ok) throw new Error(verified.error.message);
  return verified.value;
}

function activeCredential() {
  const result = Credential.createEmailPassword({
    id: validIds[1]!,
    identityId: validIds[0]!,
    email: 'artist@example.com',
    createdAt,
  });

  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function workContext() {
  const result = restoreWork({
    workId: validIds[0]!,
    correlationId: validIds[1]!,
    correlationSource: 'local',
    operation: operation('identity.authenticate').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'request',
  });

  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function command(): AuthenticateIdentityCommand {
  return {
    email: ' Artist@Example.com ',
    password: new SecretString('correct horse battery staple'),
    work: workContext(),
  };
}

function setup(
  options: Readonly<{ active?: readonly Session[]; maxActivePerIdentity?: number }> = {},
) {
  const identity = activeIdentity();
  const credential = activeCredential();
  let verifyCalls = 0;
  let committed:
    | Readonly<{
        session: Session;
        tokenDigest: SecretString;
        event: Envelope;
        evicted: readonly SessionEviction[];
      }>
    | undefined;

  const writer: SessionWriter = {
    commit: async (input) => {
      committed = input;
      return ok(undefined);
    },
  };

  const useCase = new AuthenticateIdentity({
    clock: new FakeClock(createdAt),
    ids: new TestIds(),
    credentials: {
      findByEmail: async (email) =>
        email === 'artist@example.com'
          ? ok({
              identity,
              credential,
              passwordHash: new SecretString('stored-hash'),
            })
          : ok(null),
    } satisfies CredentialAuthenticatorReader,
    passwords: {
      verify: async (password, hash) => {
        verifyCalls += 1;
        return ok(
          password.reveal() === 'correct horse battery staple' &&
            hash.reveal() === 'stored-hash',
        );
      },
      verifyDecoy: async () => {
        verifyCalls += 1;
        return ok(false as const);
      },
    } satisfies PasswordVerifier,
    sessions: {
      expiresAt: () => ok(expiresAt),
      idleTimeoutMs: 2 * HOUR,
      activityIntervalMs: 60 * 1000,
      maxActivePerIdentity: options.maxActivePerIdentity ?? 10,
    } satisfies SessionPolicy,
    active: {
      listActive: async () => ok(options.active ?? []),
    } satisfies ActiveSessionReader,
    tokens: {
      issue: async () =>
        ok({
          token: new SecretString('session-token'),
          digest: new SecretString('session-digest'),
        }),
    } satisfies SessionTokenIssuer,
    writer,
  });

  return { getCommitted: () => committed, getVerifyCalls: () => verifyCalls, useCase };
}

describe('AuthenticateIdentity', () => {
  it('verifies credentials, creates a session and returns a secret token', async () => {
    const { getCommitted, useCase } = setup();

    const result = await useCase.execute(command());

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.value.token.reveal()).toBe('session-token');
    expect(getCommitted()?.session.status).toBe('active');
    expect(getCommitted()?.tokenDigest.reveal()).toBe('session-digest');
  });

  it('records session facts without including token material', async () => {
    const { getCommitted, useCase } = setup();

    await useCase.execute(command());

    const event = getCommitted()?.event;
    expect(event).toBeDefined();

    if (!event) return;

    const raw = JSON.parse(new TextDecoder().decode(event.bytes())) as {
      type: string;
      work: { operation: string };
      payload: Record<string, unknown>;
    };

    expect(raw.type).toBe('identity.session.created.v1');
    expect(raw.work.operation).toBe('identity.authenticate');
    expect(raw.payload).not.toHaveProperty('token');
    expect(raw.payload).not.toHaveProperty('token_digest');
  });

  it('returns one unauthenticated result for unknown credentials', async () => {
    const { getVerifyCalls, useCase } = setup();
    const result = await useCase.execute({
      ...command(),
      email: 'unknown@example.com',
    });

    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    expect(result.error.type).toBe('identity.invalid_credentials');
    // An unknown email still spends one password verification (the decoy).
    expect(getVerifyCalls()).toBe(1);
  });

  it('rejects oversized passwords before invoking the verifier', async () => {
    const { getVerifyCalls, useCase } = setup();
    const result = await useCase.execute({
      ...command(),
      password: new SecretString('x'.repeat(1025)),
    });

    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    expect(result.error.type).toBe('identity.invalid_credentials');
    expect(getVerifyCalls()).toBe(0);
  });
});

describe('AuthenticateIdentity session cap', () => {
  it('revokes the oldest usable sessions so the identity keeps the cap', async () => {
    const [a, b, c] = [validIds[5]!, validIds[6]!, validIds[7]!];
    const { getCommitted, useCase } = setup({
      maxActivePerIdentity: 2,
      active: [priorSession(a, 1), priorSession(b, 0.5), priorSession(c, 1.5)],
    });

    const result = await useCase.execute(command());

    expect(result.ok).toBe(true);
    const evicted = getCommitted()?.evicted ?? [];
    expect(evicted.map((eviction) => eviction.session.id)).toEqual([a, c]);
    for (const eviction of evicted) {
      expect(eviction.session.status).toBe('revoked');
      expect(eviction.session.revokedAt).toEqual(createdAt);
      expect(eviction.event.type).toBe('identity.session.revoked.v1');
      expect(eviction.event.payload()).toMatchObject({ session_id: eviction.session.id, reason: 'session_limit' });
    }
  });

  it('does not count sessions that can no longer authenticate', async () => {
    const { getCommitted, useCase } = setup({
      maxActivePerIdentity: 2,
      // Idle for 3 hours (limit 2) and expired 1 hour ago: neither is usable.
      active: [priorSession(validIds[5]!, 4, 3), priorSession(validIds[6]!, 25, 1)],
    });

    expect((await useCase.execute(command())).ok).toBe(true);
    expect(getCommitted()?.evicted).toEqual([]);
  });

  it('evicts nothing below the cap', async () => {
    const { getCommitted, useCase } = setup({
      maxActivePerIdentity: 3,
      active: [priorSession(validIds[5]!, 1), priorSession(validIds[6]!, 2)],
    });

    expect((await useCase.execute(command())).ok).toBe(true);
    expect(getCommitted()?.evicted).toEqual([]);
  });
});
