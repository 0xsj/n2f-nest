import { describe, expect, it } from 'vitest';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../app/ports/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import {
  DefaultPasswordPolicy,
  DefaultSessionPolicy,
  DefaultVerificationPolicy,
} from './policy.js';

describe('Identity policies', () => {
  it('accepts password bounds and rejects values outside them', () => {
    const policy = new DefaultPasswordPolicy();

    expect(policy.validate(new SecretString('x'.repeat(PASSWORD_MIN_LENGTH))).ok).toBe(true);
    expect(policy.validate(new SecretString('x'.repeat(PASSWORD_MAX_LENGTH))).ok).toBe(true);

    const tooShort = policy.validate(new SecretString('x'.repeat(PASSWORD_MIN_LENGTH - 1)));
    const tooLong = policy.validate(new SecretString('x'.repeat(PASSWORD_MAX_LENGTH + 1)));

    expect(tooShort.ok).toBe(false);
    expect(tooLong.ok).toBe(false);

    if (!tooShort.ok && !tooLong.ok) {
      expect(tooShort.error.type).toBe('identity.password_too_short');
      expect(tooLong.error.type).toBe('identity.password_too_long');
    }
  });

  it('keeps session and verification expiry as explicit Identity policy', () => {
    const start = new Date('2026-09-19T00:00:00.000Z');
    const expected = new Date('2026-09-20T00:00:00.000Z');

    expect(new DefaultSessionPolicy().expiresAt(start)).toEqual({ ok: true, value: expected });
    expect(new DefaultVerificationPolicy().expiresAt(start)).toEqual({ ok: true, value: expected });
  });

  it('returns a typed refusal for an invalid policy start time', () => {
    const result = new DefaultSessionPolicy().expiresAt(new Date(Number.NaN));

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.type).toBe('identity.invalid_session_expiry');
    }
  });
});
