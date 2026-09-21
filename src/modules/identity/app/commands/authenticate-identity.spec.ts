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
  type Session,
} from '../../domain/index.js';
import {
  AuthenticateIdentity,
  type AuthenticateIdentityCommand,
} from './authenticate-identity.js';
import type {
  CredentialAuthenticatorReader,
  PasswordVerifier,
  SessionPolicy,
  SessionTokenIssuer,
  SessionWriter,
} from '../ports/index.js';

const parsedIds = [
  '00000000-0000-7000-8000-000000000001',
  '00000000-0000-7000-8000-000000000002',
  '00000000-0000-7000-8000-000000000003',
  '00000000-0000-7000-8000-000000000004',
  '00000000-0000-7000-8000-000000000005',
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

function setup() {
  const identity = activeIdentity();
  const credential = activeCredential();
  let committed:
    | Readonly<{
        session: Session;
        tokenDigest: SecretString;
        event: Envelope;
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
      verify: async (password, hash) =>
        ok(
          password.reveal() === 'correct horse battery staple' &&
            hash.reveal() === 'stored-hash',
        ),
    } satisfies PasswordVerifier,
    sessions: {
      expiresAt: () => ok(expiresAt),
    } satisfies SessionPolicy,
    tokens: {
      issue: async () =>
        ok({
          token: new SecretString('session-token'),
          digest: new SecretString('session-digest'),
        }),
    } satisfies SessionTokenIssuer,
    writer,
  });

  return { getCommitted: () => committed, useCase };
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
    const { useCase } = setup();
    const result = await useCase.execute({
      ...command(),
      email: 'unknown@example.com',
    });

    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    expect(result.error.type).toBe('identity.invalid_credentials');
  });
});
