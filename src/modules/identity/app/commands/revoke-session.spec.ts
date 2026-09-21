import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../../shared/clock/index.js';
import { ok, type Result } from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import { parse, type ID, type IDGenerator } from '../../../../shared/id/index.js';
import {
  anonymous,
  attribution,
  operation,
  restoreWork,
} from '../../../../shared/provenance/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import { Session } from '../../domain/index.js';
import {
  RevokeSession,
  type RevokeSessionCommand,
} from './revoke-session.js';
import type {
  CurrentSessionReader,
  SessionRevocationWriter,
} from '../ports/index.js';
import type { Failure } from '../../../../shared/errors/index.js';

const parsedIds = [
  '00000000-0000-7000-8000-000000000001',
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
  newId(): Result<ID, Failure> {
    return ok(validIds[2]!);
  }
}

function workContext() {
  const result = restoreWork({
    workId: validIds[0]!,
    correlationId: validIds[1]!,
    correlationSource: 'local',
    operation: operation('identity.logout').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'request',
  });

  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function activeSession() {
  const result = Session.create({
    id: validIds[1]!,
    identityId: validIds[0]!,
    createdAt,
    expiresAt,
  });

  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function command(): RevokeSessionCommand {
  return {
    sessionToken: new SecretString('session-token'),
    work: workContext(),
  };
}

function setup(session: Session | null) {
  let committed:
    | Readonly<{
        session: Session;
        event: Envelope;
      }>
    | undefined;

  const sessions: CurrentSessionReader = {
    findByToken: async () => ok(session),
  };

  const writer: SessionRevocationWriter = {
    commit: async (input) => {
      committed = input;
      return ok(undefined);
    },
  };

  const useCase = new RevokeSession({
    clock: new FakeClock(new Date('2026-09-19T01:00:00.000Z')),
    ids: new TestIds(),
    sessions,
    writer,
  });

  return { getCommitted: () => committed, useCase };
}

describe('RevokeSession', () => {
  it('revokes an active session and records a fact', async () => {
    const { getCommitted, useCase } = setup(activeSession());

    const result = await useCase.execute(command());

    expect(result.ok).toBe(true);

    if (!result.ok) return;

    expect(result.value.revoked).toBe(true);
    expect(getCommitted()?.session.status).toBe('revoked');
  });

  it('does not include token material in the revocation event', async () => {
    const { getCommitted, useCase } = setup(activeSession());

    await useCase.execute(command());

    const event = getCommitted()?.event;
    expect(event).toBeDefined();

    if (!event) return;

    const raw = JSON.parse(new TextDecoder().decode(event.bytes())) as {
      type: string;
      payload: Record<string, unknown>;
    };

    expect(raw.type).toBe('identity.session.revoked.v1');
    expect(raw.payload).not.toHaveProperty('token');
    expect(raw.payload).not.toHaveProperty('token_digest');
  });

  it('is idempotent for a missing session', async () => {
    const { getCommitted, useCase } = setup(null);

    const result = await useCase.execute(command());

    expect(result.ok).toBe(true);

    if (!result.ok) return;

    expect(result.value).toEqual({ sessionId: null, revoked: false });
    expect(getCommitted()).toBeUndefined();
  });

  it('is idempotent for an already-revoked session', async () => {
    const revoked = activeSession().revoke(
      new Date('2026-09-19T01:00:00.000Z'),
    );

    expect(revoked.ok).toBe(true);

    if (!revoked.ok) return;

    const { getCommitted, useCase } = setup(revoked.value);
    const result = await useCase.execute(command());

    expect(result.ok).toBe(true);

    if (!result.ok) return;

    expect(result.value).toEqual({
      sessionId: revoked.value.id,
      revoked: false,
    });
    expect(getCommitted()).toBeUndefined();
  });
});
