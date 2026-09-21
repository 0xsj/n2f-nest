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
} from '../ports/index.js';

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
    clock: new FakeClock(now),
    sessions,
    identities,
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
    });

    const result = await useCase.execute(query());

    expect(result.ok).toBe(false);

    if (result.ok) return;

    expect(result.error.kind).toBe('unavailable');
    expect(result.error.type).toBe('identity.session_reader_unavailable');
  });
});
