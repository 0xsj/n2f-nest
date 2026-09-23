import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../../shared/clock/index.js';
import { err, failure, ok } from '../../../../shared/errors/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import { Session } from '../../domain/index.js';
import {
  GetCurrentIdentity,
  type GetCurrentIdentityQuery,
} from './get-current-identity.js';
import type {
  CurrentSessionReader,
  IdentityView,
  IdentityViewReader,
  SessionActivityWriter,
} from '../ports/index.js';

const MINUTE = 60 * 1000;
const policy = { idleTimeoutMs: 30 * MINUTE, activityIntervalMs: MINUTE };
const noActivity: SessionActivityWriter = { record: async () => ok(undefined) };

const parsedIds = [
  '00000000-0000-7000-8000-000000000001',
  '00000000-0000-7000-8000-000000000004',
].map((value) => parse(value));

if (parsedIds.some((result) => !result.ok)) {
  throw new Error('test IDs should be valid');
}

const validIds: ID[] = parsedIds.map((result) => {
  if (!result.ok) throw new Error('test ID should be valid');
  return result.value;
});

const now = new Date('2026-09-19T00:00:00.000Z');
const expiresAt = new Date('2026-09-20T00:00:00.000Z');

function activeSession() {
  const result = Session.create({
    id: validIds[1]!,
    identityId: validIds[0]!,
    createdAt: now,
    expiresAt,
  });

  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function query(): GetCurrentIdentityQuery {
  return { sessionToken: new SecretString('session-token') };
}

function setup(
  session: ReturnType<typeof activeSession> | null = activeSession(),
  view: IdentityView | null = {
    identityId: validIds[0]!,
    status: 'active',
    verifiedAt: new Date('2026-09-19T00:01:00.000Z'),
  },
  at: Date = now,
  activity: SessionActivityWriter = noActivity,
) {
  let queriedIdentityId: ID | undefined;

  const sessions: CurrentSessionReader = {
    findByToken: async (token) =>
      token.reveal() === 'session-token' ? ok(session) : ok(null),
  };

  const identities: IdentityViewReader = {
    findById: async (identityId) => {
      queriedIdentityId = identityId;
      return ok(view);
    },
  };

  const useCase = new GetCurrentIdentity({
    clock: new FakeClock(at),
    sessions,
    identities,
    policy,
    activity,
  });

  return { getQueriedIdentityId: () => queriedIdentityId, useCase };
}

describe('GetCurrentIdentity', () => {
  it('returns a safe active identity view from a usable session', async () => {
    const { getQueriedIdentityId, useCase } = setup();

    const result = await useCase.execute(query());

    expect(result.ok).toBe(true);

    if (!result.ok) return;

    expect(result.value.identityId).toBe(validIds[0]);
    expect(result.value.status).toBe('active');
    expect(result.value.verifiedAt).toEqual(
      new Date('2026-09-19T00:01:00.000Z'),
    );
    expect(getQueriedIdentityId()).toBe(validIds[0]);
    expect('sessionToken' in result.value).toBe(false);
  });

  it('rejects a missing session without querying Identity', async () => {
    const { getQueriedIdentityId, useCase } = setup(null);

    const result = await useCase.execute(query());

    expect(result.ok).toBe(false);
    expect(getQueriedIdentityId()).toBeUndefined();
  });

  it('rejects an expired session', async () => {
    const expired = Session.create({
      id: validIds[1]!,
      identityId: validIds[0]!,
      createdAt: new Date('2026-09-18T00:00:00.000Z'),
      expiresAt: new Date('2026-09-18T23:59:00.000Z'),
    });

    expect(expired.ok).toBe(true);

    if (!expired.ok) return;

    const { useCase } = setup(expired.value);
    const result = await useCase.execute(query());

    expect(result.ok).toBe(false);

    if (result.ok) return;

    expect(result.error.type).toBe('session.expired');
  });

  it('rejects an inactive Identity', async () => {
    const { useCase } = setup(activeSession(), {
      identityId: validIds[0]!,
      status: 'suspended',
      verifiedAt: new Date('2026-09-19T00:01:00.000Z'),
    });

    const result = await useCase.execute(query());

    expect(result.ok).toBe(false);

    if (result.ok) return;

    expect(result.error.type).toBe('identity.current_unavailable');
  });

  it('normalizes session reader failures into an Identity outcome', async () => {
    const useCase = new GetCurrentIdentity({
      clock: new FakeClock(now),
      sessions: {
        findByToken: async () =>
          err(
            failure('unavailable', 'database is unavailable', {
              type: 'postgres.unavailable',
            }),
          ),
      },
      identities: {
        findById: async () => ok(null),
      },
      policy,
      activity: noActivity,
    });

    const result = await useCase.execute(query());

    expect(result.ok).toBe(false);

    if (result.ok) return;

    expect(result.error.kind).toBe('unavailable');
    expect(result.error.type).toBe('identity.session_reader_unavailable');
  });
});

describe('GetCurrentIdentity session activity', () => {
  const later = (minutes: number) => new Date(now.getTime() + minutes * MINUTE);

  function recorder() {
    const recorded: Array<{ sessionId: ID; at: Date }> = [];
    const activity: SessionActivityWriter = {
      record: async (sessionId, at) => {
        recorded.push({ sessionId, at });
        return ok(undefined);
      },
    };
    return { recorded, activity };
  }

  it('refuses a session idle for the timeout as expired', async () => {
    const { useCase } = setup(activeSession(), undefined, later(30));

    const result = await useCase.execute(query());

    expect(result).toMatchObject({ ok: false, error: { type: 'session.expired' } });
  });

  it('records use once the activity interval has passed', async () => {
    const { recorded, activity } = recorder();
    const { useCase } = setup(activeSession(), undefined, later(29), activity);

    expect((await useCase.execute(query())).ok).toBe(true);
    expect(recorded).toEqual([{ sessionId: validIds[1], at: later(29) }]);
  });

  it('does not record use within the activity interval', async () => {
    const { recorded, activity } = recorder();
    const { useCase } = setup(activeSession(), undefined, new Date(now.getTime() + MINUTE - 1), activity);

    expect((await useCase.execute(query())).ok).toBe(true);
    expect(recorded).toEqual([]);
  });

  it('keeps a session alive while it is used', async () => {
    const used = activeSession().seen(later(25));
    const { useCase } = setup(used, undefined, later(50));

    expect((await useCase.execute(query())).ok).toBe(true);
  });

  it('reports a failure to record use instead of letting the session idle out', async () => {
    const failing: SessionActivityWriter = {
      record: async () =>
        err(failure('unavailable', 'database is unavailable', { type: 'postgres.unavailable' })),
    };
    const { useCase } = setup(activeSession(), undefined, later(5), failing);

    const result = await useCase.execute(query());

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'unavailable', type: 'identity.session_activity_unavailable' },
    });
  });
});
