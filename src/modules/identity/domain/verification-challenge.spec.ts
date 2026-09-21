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
