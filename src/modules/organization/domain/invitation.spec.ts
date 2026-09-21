import { describe, expect, it } from 'vitest';
import { parse, type ID } from '../../../shared/id/index.js';
import { Invitation } from './invitation.js';

const parsed = [
  '01900000-0000-7000-8000-000000000001',
  '01900000-0000-7000-8000-000000000002',
  '01900000-0000-7000-8000-000000000003',
].map((value) => parse(value));
if (parsed.some((result) => !result.ok)) throw new Error('invitation IDs invalid');
const ids: ID[] = parsed.map((result) => {
  if (!result.ok) throw new Error('invitation ID invalid');
  return result.value;
});

const createdAt = new Date('2026-09-20T00:00:00.000Z');
const expiresAt = new Date('2026-09-27T00:00:00.000Z');

function invitation() {
  const result = Invitation.issue({
    id: ids[0]!,
    organizationId: ids[1]!,
    identityId: ids[2]!,
    role: 'member',
    createdAt,
    expiresAt,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('Invitation', () => {
  it('issues an immutable pending invitation with an expiry', () => {
    const value = invitation();
    expect(value.status).toBe('pending');
    expect(value.expiresAt).toEqual(expiresAt);
    expect(value.isExpired(new Date('2026-09-26T00:00:00.000Z'))).toBe(false);
    expect(value.isExpired(expiresAt)).toBe(true);
  });

  it('accepts a pending invitation before its expiry', () => {
    const result = invitation().accept(new Date('2026-09-21T00:00:00.000Z'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('accepted');
      expect(result.value.acceptedAt).toEqual(new Date('2026-09-21T00:00:00.000Z'));
    }
  });

  it('rejects acceptance after expiry and keeps the invitation pending', () => {
    const value = invitation();
    const result = value.accept(expiresAt);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('invitation.expired');
    expect(value.status).toBe('pending');
  });

  it('revokes a pending invitation', () => {
    const result = invitation().revoke(new Date('2026-09-21T00:00:00.000Z'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('revoked');
  });
});
