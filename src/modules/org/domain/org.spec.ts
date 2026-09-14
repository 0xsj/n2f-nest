import { describe, expect, it } from 'vitest';
import { Membership, Organization, type Role } from './index.js';
import { parse, type ID } from '../../../shared/id/index.js';
import type { Failure, Result } from '../../../shared/errors/index.js';

const value = <T>(result: Result<T, Failure>): T => { if (!result.ok) throw Error(result.error.type); return result.value; };
const orgId = value(parse('00000000-0000-4000-8000-000000000010'));
const principalId = value(parse('00000000-0000-4000-8000-000000000011'));
const membershipId = value(parse('00000000-0000-4000-8000-000000000012'));
const code = <T>(result: Result<T, Failure>) => result.ok ? undefined : result.error.type;

describe('organization domain', () => {
  it('preserves organization values and owns snapshots', () => {
    const organization = value(Organization.create(orgId, ' Team 🌱 ', 1000));
    const expected = { id: orgId, name: ' Team 🌱 ', createdAtMs: 1000 };
    expect(organization.snapshot()).toEqual(expected);
    const snapshot = organization.snapshot() as { name: string };
    snapshot.name = 'changed';
    expect(organization.snapshot()).toEqual(expected);
  });
  it('rejects invalid organization data', () => {
    for (const name of ['', ' ', '\t', 'a\n', 'a\x7f', '\ud800', '🌱'.repeat(101)])
      expect(code(Organization.create(orgId, name, 0))).toBe('org.organization_invalid');
    for (const name of ['a', '🌱🌱', 'e\u0301']) expect(Organization.create(orgId, name, 0).ok).toBe(true);
    expect(code(Organization.create('bad' as ID, 'a', 0))).toBe('org.organization_invalid');
    expect(code(Organization.create(orgId, 'a', -1))).toBe('org.organization_invalid');
    expect(code(Organization.create(orgId, 'a', 253402300800000))).toBe('org.organization_invalid');
  });
  it('makes owner membership explicit and immutable', () => {
    const membership = value(Membership.owner(membershipId, orgId, principalId, 1000));
    const expected = { id: membershipId, organizationId: orgId, principalId, role: 'owner' as Role, createdAtMs: 1000 };
    expect(membership.snapshot()).toEqual(expected);
    expect(Membership.create(membershipId, orgId, principalId, 'admin', 1000).ok).toBe(true);
    expect(code(Membership.create(membershipId, orgId, principalId, 'ownerish' as Role, 1000))).toBe('org.role_invalid');
    expect(code(Membership.create('bad' as ID, orgId, principalId, 'member', 1000))).toBe('org.membership_invalid');
    expect(code(Membership.create(membershipId, orgId, principalId, 'member', -1))).toBe('org.membership_invalid');
    const snapshot = membership.snapshot();
    expect(value(Membership.restore({ ...snapshot, role: 'admin' })).snapshot()).toEqual({ ...expected, role: 'admin' });
  });
});
