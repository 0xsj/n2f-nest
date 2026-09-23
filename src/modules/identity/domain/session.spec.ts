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

describe('Session activity', () => {
  const MINUTE = 60 * 1000;
  const at = (minutes: number) => new Date(createdAt.getTime() + minutes * MINUTE);

  it('starts as last used when created', () => {
    expect(activeSession().lastSeenAt).toEqual(createdAt);
  });

  it('expires after the idle timeout without use, and not before', () => {
    const session = activeSession();

    expect(session.assertUsable(at(30), 30 * MINUTE)).toMatchObject({
      ok: false,
      error: { kind: 'unauthenticated', type: 'session.expired' },
    });
    expect(session.assertUsable(new Date(at(30).getTime() - 1), 30 * MINUTE).ok).toBe(true);
    expect(session.assertUsable(at(600)).ok).toBe(true);
  });

  it('measures idleness from the last use', () => {
    const used = activeSession().seen(at(20));

    expect(used.lastSeenAt).toEqual(at(20));
    expect(used.assertUsable(at(49), 30 * MINUTE).ok).toBe(true);
    expect(used.assertUsable(at(50), 30 * MINUTE).ok).toBe(false);
  });

  it('only moves last use forward and keeps the version', () => {
    const used = activeSession().seen(at(20));

    expect(used.seen(at(10))).toBe(used);
    expect(used.seen(new Date(Number.NaN))).toBe(used);
    expect(used.version).toBe(activeSession().version);
  });

  it('never outlives its absolute expiry through use', () => {
    const used = activeSession().seen(new Date(expiresAt.getTime() - MINUTE));

    expect(used.assertUsable(expiresAt, 30 * MINUTE)).toMatchObject({ ok: false });
  });

  it('refuses to restore a last use before creation or an invalid one', () => {
    const base = {
      id,
      identityId: ownerId,
      status: 'active' as const,
      createdAt,
      expiresAt,
      revokedAt: null,
      version: 1,
    };

    expect(Session.restore({ ...base, lastSeenAt: at(5) }).ok).toBe(true);
    expect(Session.restore({ ...base, lastSeenAt: new Date(createdAt.getTime() - 1) })).toMatchObject({
      ok: false,
      error: { type: 'session.invalid_state' },
    });
    expect(Session.restore({ ...base, lastSeenAt: new Date(Number.NaN) }).ok).toBe(false);
  });
});

describe('Session invariants', () => {
  const MINUTE = 60 * 1000;
  const at = (minutes: number) => new Date(createdAt.getTime() + minutes * MINUTE);

  function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  const createBase = { id, identityId: ownerId, createdAt, expiresAt };
  const restoreBase = {
    ...createBase,
    status: 'revoked' as const,
    lastSeenAt: at(10),
    revokedAt: at(20),
    version: 4,
  };

  it('refuses invalid creation times and expiry', () => {
    for (const patch of [
      { createdAt: new Date(Number.NaN) },
      { expiresAt: new Date(Number.NaN) },
    ]) {
      expect(Session.create({ ...createBase, ...patch })).toMatchObject({
        ok: false,
        error: { kind: 'invalid', type: 'session.invalid_time' },
      });
    }
    for (const expires of [createdAt, new Date(createdAt.getTime() - 1)]) {
      expect(Session.create({ ...createBase, expiresAt: expires })).toMatchObject({
        ok: false,
        error: { kind: 'invalid', type: 'session.invalid_expiry' },
      });
    }
    expect(Session.create({ ...createBase, expiresAt: new Date(createdAt.getTime() + 1) }).ok).toBe(true);
  });

  it('starts unsaved, owns copies of its dates and versions only on save', () => {
    const created = new Date(createdAt.getTime());
    const expires = new Date(expiresAt.getTime());
    const session = unwrap(Session.create({ ...createBase, createdAt: created, expiresAt: expires }));
    created.setTime(0);
    expires.setTime(0);
    session.createdAt.setTime(0);
    session.expiresAt.setTime(0);
    session.lastSeenAt.setTime(0);

    expect(session.createdAt).toEqual(createdAt);
    expect(session.expiresAt).toEqual(expiresAt);
    expect(session.lastSeenAt).toEqual(createdAt);
    expect(session.version).toBe(0);

    const saved = session.saved();
    expect(session.version).toBe(0);
    expect(saved.version).toBe(1);
    expect(saved.status).toBe('active');

    const seenAt = at(5);
    const seen = saved.seen(seenAt);
    seenAt.setTime(0);
    expect(seen).not.toBe(saved);
    expect(seen.lastSeenAt).toEqual(at(5));
    expect(seen.version).toBe(1);
    expect(saved.lastSeenAt).toEqual(createdAt);
    expect(saved.seen(createdAt)).toBe(saved);

    const time = at(30);
    const revoked = unwrap(seen.revoke(time));
    time.setTime(0);
    revoked.revokedAt!.setTime(0);
    expect(revoked.revokedAt).toEqual(at(30));
    expect(revoked.version).toBe(1);
    expect(revoked.lastSeenAt).toEqual(at(5));
    expect(revoked.createdAt).toEqual(createdAt);
    expect(revoked.expiresAt).toEqual(expiresAt);
    expect(revoked.id).toBe(id);
    expect(revoked.identityId).toBe(ownerId);
  });

  it('refuses an invalid check time', () => {
    expect(activeSession().assertUsable(new Date(Number.NaN))).toMatchObject({
      ok: false,
      error: { kind: 'invalid', type: 'session.invalid_check_time' },
    });
  });

  it('reports revocation as unauthenticated, ahead of expiry', () => {
    const revoked = unwrap(activeSession().revoke(at(1)));

    expect(revoked.assertUsable(expiresAt)).toMatchObject({
      ok: false,
      error: { kind: 'unauthenticated', type: 'session.revoked' },
    });
    expect(activeSession().assertUsable(expiresAt)).toMatchObject({
      ok: false,
      error: { kind: 'unauthenticated', type: 'session.expired' },
    });
    expect(activeSession().assertUsable(new Date(expiresAt.getTime() - 1))).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it('refuses invalid or early revocation', () => {
    const session = activeSession();

    expect(session.revoke(new Date(Number.NaN))).toMatchObject({
      ok: false,
      error: { kind: 'invalid', type: 'session.invalid_revocation_time' },
    });
    expect(session.revoke(new Date(createdAt.getTime() - 1))).toMatchObject({
      ok: false,
      error: { kind: 'invalid', type: 'session.non_monotonic_time' },
    });
    const revoked = unwrap(session.revoke(createdAt));
    expect(revoked.revoke(at(1))).toMatchObject({
      ok: false,
      error: { kind: 'invalid', type: 'session.already_revoked' },
    });
  });

  it('restores stored state as copies', () => {
    const revokedAt = at(20);
    const lastSeenAt = at(10);
    const session = unwrap(Session.restore({ ...restoreBase, revokedAt, lastSeenAt }));
    revokedAt.setTime(0);
    lastSeenAt.setTime(0);

    expect(session.id).toBe(id);
    expect(session.identityId).toBe(ownerId);
    expect(session.status).toBe('revoked');
    expect(session.createdAt).toEqual(createdAt);
    expect(session.expiresAt).toEqual(expiresAt);
    expect(session.lastSeenAt).toEqual(at(10));
    expect(session.revokedAt).toEqual(at(20));
    expect(session.version).toBe(4);

    expect(Session.restore({ ...restoreBase, lastSeenAt: createdAt }).ok).toBe(true);
    expect(Session.restore({ ...restoreBase, revokedAt: createdAt }).ok).toBe(true);
    expect(
      Session.restore({ ...restoreBase, status: 'active', revokedAt: null }),
    ).toMatchObject({ ok: true, value: { status: 'active', revokedAt: null } });
  });

  it('refuses malformed or inconsistent stored state', () => {
    for (const patch of [
      { status: 'expired' as never },
      { createdAt: new Date(Number.NaN) },
      { expiresAt: new Date(Number.NaN) },
      { revokedAt: new Date(Number.NaN) },
      { version: 0 },
      { status: 'active' as const },
      { revokedAt: null },
      { revokedAt: new Date(createdAt.getTime() - 1) },
    ]) {
      expect(Session.restore({ ...restoreBase, ...patch }), JSON.stringify(patch)).toMatchObject({
        ok: false,
        error: { kind: 'invalid', type: 'session.invalid_state' },
      });
    }
    for (const expires of [createdAt, new Date(createdAt.getTime() - 1)]) {
      expect(
        Session.restore({ ...restoreBase, expiresAt: expires, lastSeenAt: createdAt, revokedAt: createdAt }),
      ).toMatchObject({ ok: false, error: { kind: 'invalid', type: 'session.invalid_expiry' } });
    }
  });
});
