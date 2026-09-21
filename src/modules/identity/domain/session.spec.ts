import { describe, expect, it } from 'vitest';
import { parse } from '../../../shared/id/index.js';
import { Session } from './session.js';

const sessionId = parse('00000000-0000-7000-8000-000000000004');
const identityId = parse('00000000-0000-7000-8000-000000000001');

if (!sessionId.ok || !identityId.ok) {
  throw new Error('test IDs should be valid');
}

const id = sessionId.value;
const ownerId = identityId.value;
const createdAt = new Date('2026-09-19T00:00:00.000Z');
const expiresAt = new Date('2026-09-20T00:00:00.000Z');

function activeSession() {
  const result = Session.create({
    id,
    identityId: ownerId,
    createdAt,
    expiresAt,
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.value;
}

describe('Session', () => {
  it('starts active with an expiry', () => {
    const session = activeSession();

    expect(session.id).toBe(id);
    expect(session.identityId).toBe(ownerId);
    expect(session.status).toBe('active');
    expect(session.expiresAt).toEqual(expiresAt);
    expect(session.revokedAt).toBeNull();
  });

  it('is usable before expiry', () => {
    const result = activeSession().assertUsable(
      new Date('2026-09-19T12:00:00.000Z'),
    );

    expect(result.ok).toBe(true);
  });

  it('rejects use at or after expiry', () => {
    const result = activeSession().assertUsable(expiresAt);

    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    expect(result.error.type).toBe('session.expired');
  });

  it('revokes immutably', () => {
    const session = activeSession();
    const revokedAt = new Date('2026-09-19T01:00:00.000Z');

    const result = session.revoke(revokedAt);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(session.status).toBe('active');
    expect(result.value.status).toBe('revoked');
    expect(result.value.revokedAt).toEqual(revokedAt);
  });

  it('rejects use after revocation', () => {
    const revoked = activeSession().revoke(
      new Date('2026-09-19T01:00:00.000Z'),
    );

    expect(revoked.ok).toBe(true);

    if (!revoked.ok) {
      return;
    }

    const result = revoked.value.assertUsable(
      new Date('2026-09-19T02:00:00.000Z'),
    );

    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    expect(result.error.type).toBe('session.revoked');
  });
});
