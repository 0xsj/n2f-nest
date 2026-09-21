import { describe, expect, it } from 'vitest';
import { parse } from '../../../shared/id/index.js';
import { Membership } from './membership.js';

const ids = [
  '01900000-0000-7000-8000-000000000001',
  '01900000-0000-7000-8000-000000000002',
  '01900000-0000-7000-8000-000000000003',
].map((value) => parse(value));
if (ids.some((value) => !value.ok)) throw new Error('membership fixtures invalid');

const [membershipId, organizationId, identityId] = ids.map((value) => {
  if (!value.ok) throw new Error('membership fixture invalid');
  return value.value;
});
const createdAt = new Date('2026-09-20T00:00:00.000Z');

function owner() {
  const result = Membership.add({
    id: membershipId,
    organizationId,
    identityId,
    role: 'owner',
    createdAt,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('Membership', () => {
  it('starts as an active owner membership', () => {
    const membership = owner();

    expect(membership.role).toBe('owner');
    expect(membership.status).toBe('active');
    expect(membership.revokedAt).toBeNull();
  });

  it('changes role and revokes immutably', () => {
    const membership = owner();
    const changed = membership.changeRole('admin', new Date('2026-09-20T01:00:00.000Z'));
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;

    const revoked = changed.value.revoke(new Date('2026-09-20T02:00:00.000Z'));
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) return;

    expect(membership.role).toBe('owner');
    expect(membership.status).toBe('active');
    expect(revoked.value.role).toBe('admin');
    expect(revoked.value.status).toBe('revoked');
    expect(revoked.value.revokedAt).toEqual(new Date('2026-09-20T02:00:00.000Z'));
  });

  it('does not allow revoked memberships to change role', () => {
    const membership = owner();
    const revoked = membership.revoke(new Date('2026-09-20T01:00:00.000Z'));
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) return;

    const changed = revoked.value.changeRole('member', new Date('2026-09-20T02:00:00.000Z'));
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.type).toBe('membership.revoked');
  });
});
