import { describe, expect, it } from 'vitest';
import { parse } from '../../../shared/id/index.js';
import {
  MEMBERSHIP_ROLES,
  Membership,
  type AddMembershipInput,
  type MembershipRole,
  type MembershipStatus,
  type RestoreMembershipInput,
} from './membership.js';

const [membershipId, organizationId, identityId] = [
  '01900000-0000-7000-8000-000000000001',
  '01900000-0000-7000-8000-000000000002',
  '01900000-0000-7000-8000-000000000003',
].map((value) => {
  const result = parse(value);
  if (!result.ok) throw new Error('membership fixture invalid');
  return result.value;
});

const createdAt = new Date('2026-09-20T00:00:00.000Z');
const t1 = new Date('2026-09-20T01:00:00.000Z');
const t2 = new Date('2026-09-20T02:00:00.000Z');
const invalidDate = new Date('not a date');
const dateLike = { getTime: () => t2.getTime() } as unknown as Date;

function add(overrides: Partial<AddMembershipInput> = {}) {
  return Membership.add({
    id: membershipId!,
    organizationId: organizationId!,
    identityId: identityId!,
    role: 'member',
    createdAt,
    ...overrides,
  });
}

function restoreInput(
  overrides: Partial<RestoreMembershipInput> = {},
): RestoreMembershipInput {
  return {
    id: membershipId!,
    organizationId: organizationId!,
    identityId: identityId!,
    role: 'admin',
    status: 'active',
    createdAt,
    updatedAt: t1,
    revokedAt: null,
    version: 4,
    ...overrides,
  };
}

function restored(overrides: Partial<RestoreMembershipInput> = {}): Membership {
  const result = Membership.restore(restoreInput(overrides));
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function failureType(result: { ok: boolean }) {
  expect(result.ok).toBe(false);
  return (result as unknown as { error: { type: string } }).error.type;
}

describe('Membership.add', () => {
  it('adds every role as an active, unsaved membership', () => {
    for (const role of MEMBERSHIP_ROLES) {
      const result = add({ role });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.id).toBe(membershipId);
      expect(result.value.organizationId).toBe(organizationId);
      expect(result.value.identityId).toBe(identityId);
      expect(result.value.role).toBe(role);
      expect(result.value.status).toBe('active');
      expect(result.value.createdAt).toEqual(createdAt);
      expect(result.value.updatedAt).toEqual(createdAt);
      expect(result.value.revokedAt).toBeNull();
      expect(result.value.version).toBe(0);
    }
  });

  it('rejects unknown roles with an invalid-kind failure', () => {
    for (const role of ['guest', 'OWNER', '', 3, undefined]) {
      const result = add({ role });
      expect(failureType(result)).toBe('membership.invalid_role');
      if (!result.ok) expect(result.error.kind).toBe('invalid');
    }
  });

  it('rejects invalid creation times, after checking the role', () => {
    expect(failureType(add({ createdAt: invalidDate }))).toBe(
      'membership.invalid_created_at',
    );
    expect(failureType(add({ createdAt: dateLike }))).toBe(
      'membership.invalid_created_at',
    );
    expect(failureType(add({ role: 'guest', createdAt: invalidDate }))).toBe(
      'membership.invalid_role',
    );
  });

  it('copies dates in and out', () => {
    const c = new Date(createdAt.getTime());
    const result = add({ createdAt: c });
    if (!result.ok) throw new Error(result.error.message);
    c.setTime(0);
    expect(result.value.createdAt).toEqual(createdAt);
    expect(result.value.updatedAt).toEqual(createdAt);
    result.value.createdAt.setTime(0);
    result.value.updatedAt.setTime(0);
    expect(result.value.createdAt).toEqual(createdAt);
    expect(result.value.updatedAt).toEqual(createdAt);
  });
});

describe('Membership.restore', () => {
  it('restores active and revoked states with their version', () => {
    const active = restored();
    expect(active.status).toBe('active');
    expect(active.role).toBe('admin');
    expect(active.version).toBe(4);
    expect(active.id).toBe(membershipId);
    expect(active.organizationId).toBe(organizationId);
    expect(active.identityId).toBe(identityId);
    expect(active.createdAt).toEqual(createdAt);
    expect(active.updatedAt).toEqual(t1);
    expect(active.revokedAt).toBeNull();

    const revoked = restored({ status: 'revoked', revokedAt: t1 });
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedAt).toEqual(t1);
  });

  it('rejects malformed fields as invalid state', () => {
    const cases: Partial<RestoreMembershipInput>[] = [
      { role: 'guest' as MembershipRole },
      { status: 'suspended' as MembershipStatus },
      { createdAt: invalidDate },
      { updatedAt: invalidDate },
      { status: 'revoked', revokedAt: invalidDate },
      { version: 0 },
    ];
    for (const overrides of cases) {
      expect(failureType(Membership.restore(restoreInput(overrides)))).toBe(
        'membership.invalid_state',
      );
    }
  });

  it('rejects status that disagrees with revokedAt', () => {
    expect(
      failureType(Membership.restore(restoreInput({ status: 'active', revokedAt: t1 }))),
    ).toBe('membership.invalid_state');
    expect(
      failureType(Membership.restore(restoreInput({ status: 'revoked', revokedAt: null }))),
    ).toBe('membership.invalid_state');
  });

  it('rejects update before creation but allows equality', () => {
    expect(
      failureType(
        Membership.restore(
          restoreInput({ updatedAt: new Date(createdAt.getTime() - 1) }),
        ),
      ),
    ).toBe('membership.non_monotonic_time');
    expect(Membership.restore(restoreInput({ updatedAt: createdAt })).ok).toBe(
      true,
    );
  });

  it('copies input dates', () => {
    const c = new Date(createdAt.getTime());
    const u = new Date(t1.getTime());
    const r = new Date(t1.getTime());
    const result = Membership.restore(
      restoreInput({ status: 'revoked', createdAt: c, updatedAt: u, revokedAt: r }),
    );
    if (!result.ok) throw new Error(result.error.message);
    c.setTime(0);
    u.setTime(0);
    r.setTime(0);
    expect(result.value.createdAt).toEqual(createdAt);
    expect(result.value.updatedAt).toEqual(t1);
    expect(result.value.revokedAt).toEqual(t1);
    result.value.revokedAt!.setTime(0);
    expect(result.value.revokedAt).toEqual(t1);
  });
});

describe('Membership.saved', () => {
  it('advances the version without changing state', () => {
    const membership = restored({ status: 'revoked', revokedAt: t1 });
    const saved = membership.saved();
    expect(saved.version).toBe(5);
    expect(membership.version).toBe(4);
    expect(saved.status).toBe('revoked');
    expect(saved.revokedAt).toEqual(t1);
    expect(saved.role).toBe('admin');
  });
});

describe('Membership transitions', () => {
  it('changeRole changes only role and updatedAt and keeps the version', () => {
    const membership = restored();
    const result = membership.changeRole('owner', t2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.role).toBe('owner');
    expect(result.value.status).toBe('active');
    expect(result.value.updatedAt).toEqual(t2);
    expect(result.value.createdAt).toEqual(createdAt);
    expect(result.value.revokedAt).toBeNull();
    expect(result.value.version).toBe(4);
    expect(membership.role).toBe('admin');
    expect(membership.updatedAt).toEqual(t1);
  });

  it('changeRole rejects unknown roles, checking role before revoked status', () => {
    expect(failureType(restored().changeRole('guest', t2))).toBe(
      'membership.invalid_role',
    );
    const revoked = restored({ status: 'revoked', revokedAt: t1 });
    expect(failureType(revoked.changeRole('guest', t2))).toBe(
      'membership.invalid_role',
    );
    expect(failureType(revoked.changeRole('member', t2))).toBe(
      'membership.revoked',
    );
  });

  it('revoke stamps revokedAt and updatedAt and keeps role and version', () => {
    const membership = restored();
    const result = membership.revoke(t2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('revoked');
    expect(result.value.revokedAt).toEqual(t2);
    expect(result.value.updatedAt).toEqual(t2);
    expect(result.value.role).toBe('admin');
    expect(result.value.version).toBe(4);
    expect(membership.status).toBe('active');
    expect(membership.revokedAt).toBeNull();
  });

  it('revoke refuses an already revoked membership', () => {
    const revoked = restored({ status: 'revoked', revokedAt: t1 });
    expect(failureType(revoked.revoke(t2))).toBe('membership.already_revoked');
  });

  it('rejects invalid and backwards times before other checks, allowing the same instant', () => {
    const active = restored();
    const revoked = restored({ status: 'revoked', revokedAt: t1 });
    for (const run of [
      (m: Membership, at: Date) => m.changeRole('member', at),
      (m: Membership, at: Date) => m.revoke(at),
    ]) {
      expect(failureType(run(active, invalidDate))).toBe(
        'membership.invalid_transition_time',
      );
      expect(failureType(run(active, dateLike))).toBe(
        'membership.invalid_transition_time',
      );
      expect(failureType(run(active, new Date(t1.getTime() - 1)))).toBe(
        'membership.non_monotonic_time',
      );
      expect(run(active, new Date(t1.getTime())).ok).toBe(true);
      expect(failureType(run(revoked, invalidDate))).toBe(
        'membership.invalid_transition_time',
      );
      expect(failureType(run(revoked, createdAt))).toBe(
        'membership.non_monotonic_time',
      );
    }
    expect(failureType(active.changeRole('guest', invalidDate))).toBe(
      'membership.invalid_transition_time',
    );
  });

  it('copies the transition time', () => {
    const at = new Date(t2.getTime());
    const result = restored().revoke(at);
    if (!result.ok) throw new Error(result.error.message);
    at.setTime(0);
    expect(result.value.revokedAt).toEqual(t2);
    expect(result.value.updatedAt).toEqual(t2);
  });
});
