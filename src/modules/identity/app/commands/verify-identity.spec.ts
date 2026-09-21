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
import { Identity, VerificationChallenge } from '../../domain/index.js';
import {
  VerifyIdentity,
  type VerifyIdentityCommand,
} from './verify-identity.js';
import type {
  IdentityReader,
  VerificationChallengeReader,
  VerificationTokenVerifier,
  VerificationWriter,
} from '../ports/index.js';

const parsedIds = [
  '00000000-0000-7000-8000-000000000001',
  '00000000-0000-7000-8000-000000000002',
  '00000000-0000-7000-8000-000000000003',
  '00000000-0000-7000-8000-000000000004',
].map((value) => parse(value));

if (parsedIds.some((result) => !result.ok)) {
  throw new Error('test IDs should be valid');
}

const validIds: ID[] = parsedIds.map((result) => {
  if (!result.ok) throw new Error('test ID should be valid');
  return result.value;
});

const issuedAt = new Date('2026-09-19T00:00:00.000Z');
const expiresAt = new Date('2026-09-19T01:00:00.000Z');

class TestIds implements IDGenerator {
  private position = 3;

  newId(): Result<ID, Failure> {
    const value = validIds[this.position++];

    return value === undefined
      ? err(failure('unavailable', 'test IDs exhausted', { type: 'test.ids' }))
      : ok(value);
  }
}

function workContext() {
  const result = restoreWork({
    workId: validIds[0]!,
    correlationId: validIds[1]!,
    correlationSource: 'local',
    operation: operation('identity.verify').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'request',
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.value;
}

function pendingIdentity() {
  const result = Identity.register({
    id: validIds[0]!,
    createdAt: issuedAt,
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.value;
}

function issuedChallenge() {
  const result = VerificationChallenge.issue({
    id: validIds[2]!,
    identityId: validIds[0]!,
    purpose: 'email_verification',
    issuedAt,
    expiresAt,
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.value;
}

function command(): VerifyIdentityCommand {
  return {
    challengeId: validIds[2]!,
    token: new SecretString('verification-token'),
    work: workContext(),
  };
}

function setup() {
  const identity = pendingIdentity();
  const challenge = issuedChallenge();
  let committed:
    | Readonly<{
        identity: Identity;
        challenge: VerificationChallenge;
        event: Envelope;
      }>
    | undefined;

  const writer: VerificationWriter = {
    commit: async (input) => {
      committed = input;
      return ok(undefined);
    },
  };

  const useCase = new VerifyIdentity({
    clock: new FakeClock(new Date('2026-09-19T00:30:00.000Z')),
    ids: new TestIds(),
    identities: {
      find: async () => ok(identity),
    } satisfies IdentityReader,
    challenges: {
      find: async () =>
        ok({
          challenge,
          tokenDigest: new SecretString('digest'),
        }),
    } satisfies VerificationChallengeReader,
    tokens: {
      verify: async (token, digest) =>
        ok(token.reveal() === 'verification-token' && digest.reveal() === 'digest'),
    } satisfies VerificationTokenVerifier,
    writer,
  });

  return { getCommitted: () => committed, useCase };
}

describe('VerifyIdentity', () => {
  it('consumes the challenge, activates the identity and commits an event', async () => {
    const { getCommitted, useCase } = setup();

    const result = await useCase.execute(command());

    expect(result.ok).toBe(true);
    expect(result.value?.status).toBe('active');
    expect(getCommitted()?.identity.status).toBe('active');
    expect(getCommitted()?.challenge.status).toBe('consumed');
  });

  it('records provenance and excludes the verification token', async () => {
    const { getCommitted, useCase } = setup();

    await useCase.execute(command());

    const event = getCommitted()?.event;
    expect(event).toBeDefined();

    if (!event) {
      return;
    }

    const raw = JSON.parse(new TextDecoder().decode(event.bytes())) as {
      type: string;
      work: { operation: string };
      payload: Record<string, unknown>;
    };

    expect(raw.type).toBe('identity.verified.v1');
    expect(raw.work.operation).toBe('identity.verify');
    expect(raw.payload).not.toHaveProperty('token');
    expect(raw.payload).not.toHaveProperty('token_digest');
  });

  it('does not write when token verification fails', async () => {
    const { getCommitted, useCase } = setup();
    const result = await useCase.execute({
      ...command(),
      token: new SecretString('wrong-token'),
    });

    expect(result.ok).toBe(false);
    expect(getCommitted()).toBeUndefined();
  });
});
