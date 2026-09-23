import { describe, expect, it } from 'vitest';
import { parse } from '../../../shared/id/index.js';
import { VerificationChallenge } from './verification-challenge.js';

const challengeId = parse('00000000-0000-7000-8000-000000000003');
const identityId = parse('00000000-0000-7000-8000-000000000001');

if (!challengeId.ok || !identityId.ok) {
  throw new Error('test IDs should be valid');
}

const id = challengeId.value;
const ownerId = identityId.value;
const issuedAt = new Date('2026-09-19T00:00:00.000Z');
const expiresAt = new Date('2026-09-19T01:00:00.000Z');

function issuedChallenge() {
  const result = VerificationChallenge.issue({
    id,
    identityId: ownerId,
    purpose: 'email_verification',
    issuedAt,
    expiresAt,
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.value;
}

describe('VerificationChallenge', () => {
  it('starts issued with an owner and expiry', () => {
    const challenge = issuedChallenge();

    expect(challenge.id).toBe(id);
    expect(challenge.identityId).toBe(ownerId);
    expect(challenge.purpose).toBe('email_verification');
    expect(challenge.status).toBe('issued');
    expect(challenge.issuedAt).toEqual(issuedAt);
    expect(challenge.expiresAt).toEqual(expiresAt);
    expect(challenge.consumedAt).toBeNull();
  });

  it('consumes before expiry without mutating the original', () => {
    const challenge = issuedChallenge();
    const consumedAt = new Date('2026-09-19T00:30:00.000Z');

    const result = challenge.consume(consumedAt);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(challenge.status).toBe('issued');
    expect(result.value.status).toBe('consumed');
    expect(result.value.consumedAt).toEqual(consumedAt);
  });

  it('rejects consumption at or after expiry', () => {
    const challenge = issuedChallenge();

    const result = challenge.consume(expiresAt);

    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    expect(result.error.type).toBe('verification.expired');
  });

  it('rejects reuse after consumption', () => {
    const challenge = issuedChallenge();
    const consumed = challenge.consume(
      new Date('2026-09-19T00:30:00.000Z'),
    );

    expect(consumed.ok).toBe(true);

    if (!consumed.ok) {
      return;
    }

    const result = consumed.value.consume(
      new Date('2026-09-19T00:31:00.000Z'),
    );

    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    expect(result.error.type).toBe('verification.already_consumed');
  });

  it('rejects an expiry that is not after issuance', () => {
    const result = VerificationChallenge.issue({
      id,
      identityId: ownerId,
      purpose: 'email_verification',
      issuedAt,
      expiresAt: issuedAt,
    });

    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    expect(result.error.type).toBe('verification.invalid_expiry');
  });
});

describe('VerificationChallenge invariants', () => {
  const at = (minutes: number) =>
    new Date(issuedAt.getTime() + minutes * 60 * 1000);

  function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  const issueBase = {
    id,
    identityId: ownerId,
    purpose: 'email_verification' as const,
    issuedAt,
    expiresAt,
  };
  const restoreBase = {
    ...issueBase,
    status: 'consumed' as const,
    consumedAt: at(30),
    version: 2,
  };

  it('refuses invalid issue times', () => {
    for (const patch of [
      { issuedAt: new Date(Number.NaN) },
      { expiresAt: new Date(Number.NaN) },
    ]) {
      expect(VerificationChallenge.issue({ ...issueBase, ...patch })).toMatchObject({
        ok: false,
        error: { kind: 'invalid', type: 'verification.invalid_time' },
      });
    }
    expect(
      VerificationChallenge.issue({ ...issueBase, expiresAt: new Date(issuedAt.getTime() - 1) }),
    ).toMatchObject({ ok: false, error: { type: 'verification.invalid_expiry' } });
    expect(
      VerificationChallenge.issue({ ...issueBase, expiresAt: new Date(issuedAt.getTime() + 1) }).ok,
    ).toBe(true);
  });

  it('starts unsaved, owns copies of its dates and versions only on save', () => {
    const issued = new Date(issuedAt.getTime());
    const expires = new Date(expiresAt.getTime());
    const challenge = unwrap(
      VerificationChallenge.issue({ ...issueBase, issuedAt: issued, expiresAt: expires }),
    );
    issued.setTime(0);
    expires.setTime(0);
    challenge.issuedAt.setTime(0);
    challenge.expiresAt.setTime(0);

    expect(challenge.issuedAt).toEqual(issuedAt);
    expect(challenge.expiresAt).toEqual(expiresAt);
    expect(challenge.version).toBe(0);

    const saved = challenge.saved();
    expect(challenge.version).toBe(0);
    expect(saved.version).toBe(1);
    expect(saved.status).toBe('issued');

    const time = at(10);
    const consumed = unwrap(saved.consume(time));
    time.setTime(0);
    consumed.consumedAt!.setTime(0);
    expect(consumed.consumedAt).toEqual(at(10));
    expect(consumed.version).toBe(1);
    expect(consumed.id).toBe(id);
    expect(consumed.identityId).toBe(ownerId);
    expect(consumed.purpose).toBe('email_verification');
    expect(consumed.issuedAt).toEqual(issuedAt);
    expect(consumed.expiresAt).toEqual(expiresAt);
  });

  it('consumes from issuance up to just before expiry', () => {
    const challenge = issuedChallenge();

    expect(challenge.consume(issuedAt).ok).toBe(true);
    expect(challenge.consume(new Date(expiresAt.getTime() - 1)).ok).toBe(true);
    expect(challenge.consume(new Date(expiresAt.getTime() + 1))).toMatchObject({
      ok: false,
      error: { kind: 'invalid', type: 'verification.expired' },
    });
  });

  it('refuses invalid or early consumption times', () => {
    const challenge = issuedChallenge();

    expect(challenge.consume(new Date(Number.NaN))).toMatchObject({
      ok: false,
      error: { kind: 'invalid', type: 'verification.invalid_consumption_time' },
    });
    expect(challenge.consume(new Date(issuedAt.getTime() - 1))).toMatchObject({
      ok: false,
      error: { kind: 'invalid', type: 'verification.non_monotonic_time' },
    });
  });

  it('reports reuse ahead of expiry', () => {
    const consumed = unwrap(issuedChallenge().consume(at(10)));

    expect(consumed.consume(expiresAt)).toMatchObject({
      ok: false,
      error: { type: 'verification.already_consumed' },
    });
  });

  it('restores stored state as copies', () => {
    const consumedAt = at(30);
    const challenge = unwrap(VerificationChallenge.restore({ ...restoreBase, consumedAt }));
    consumedAt.setTime(0);

    expect(challenge.id).toBe(id);
    expect(challenge.identityId).toBe(ownerId);
    expect(challenge.purpose).toBe('email_verification');
    expect(challenge.status).toBe('consumed');
    expect(challenge.issuedAt).toEqual(issuedAt);
    expect(challenge.expiresAt).toEqual(expiresAt);
    expect(challenge.consumedAt).toEqual(at(30));
    expect(challenge.version).toBe(2);

    expect(
      VerificationChallenge.restore({ ...restoreBase, status: 'issued', consumedAt: null }),
    ).toMatchObject({ ok: true, value: { status: 'issued', consumedAt: null } });
    expect(VerificationChallenge.restore({ ...restoreBase, consumedAt: issuedAt }).ok).toBe(true);
    expect(
      VerificationChallenge.restore({ ...restoreBase, consumedAt: new Date(expiresAt.getTime() - 1) }).ok,
    ).toBe(true);
  });

  it('refuses malformed or inconsistent stored state', () => {
    for (const patch of [
      { purpose: 'password_reset' as never },
      { status: 'revoked' as never },
      { issuedAt: new Date(Number.NaN) },
      { expiresAt: new Date(Number.NaN) },
      { consumedAt: new Date(Number.NaN) },
      { version: 0 },
      { status: 'issued' as const },
      { consumedAt: null },
      { consumedAt: new Date(issuedAt.getTime() - 1) },
      { consumedAt: expiresAt },
    ]) {
      expect(
        VerificationChallenge.restore({ ...restoreBase, ...patch }),
        JSON.stringify(patch),
      ).toMatchObject({
        ok: false,
        error: { kind: 'invalid', type: 'verification.invalid_state' },
      });
    }
    for (const expires of [issuedAt, new Date(issuedAt.getTime() - 1)]) {
      expect(
        VerificationChallenge.restore({
          ...restoreBase,
          status: 'issued',
          consumedAt: null,
          expiresAt: expires,
        }),
      ).toMatchObject({ ok: false, error: { type: 'verification.invalid_expiry' } });
    }
  });
});
