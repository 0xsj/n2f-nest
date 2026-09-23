import { describe, expect, it } from 'vitest';
import { parse, type ID } from '../../../shared/id/index.js';
import {
  INVITATION_ROLES,
  Invitation,
  type InvitationRole,
  type InvitationStatus,
  type IssueInvitationInput,
  type RestoreInvitationInput,
} from './invitation.js';

const ids: ID[] = [
  '01900000-0000-7000-8000-000000000001',
  '01900000-0000-7000-8000-000000000002',
  '01900000-0000-7000-8000-000000000003',
].map((value) => {
  const result = parse(value);
  if (!result.ok) throw new Error('invitation ID invalid');
  return result.value;
});

const createdAt = new Date('2026-09-20T00:00:00.000Z');
const t1 = new Date('2026-09-21T00:00:00.000Z');
const t2 = new Date('2026-09-22T00:00:00.000Z');
const expiresAt = new Date('2026-09-27T00:00:00.000Z');
const invalidDate = new Date('not a date');
const dateLike = { getTime: () => t1.getTime() } as unknown as Date;

function issue(overrides: Partial<IssueInvitationInput> = {}) {
  return Invitation.issue({
    id: ids[0]!,
    organizationId: ids[1]!,
    identityId: ids[2]!,
    role: 'member',
    createdAt,
    expiresAt,
    ...overrides,
  });
}

function pending(): Invitation {
  const result = issue();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function restoreInput(
  overrides: Partial<RestoreInvitationInput> = {},
): RestoreInvitationInput {
  return {
    id: ids[0]!,
    organizationId: ids[1]!,
    identityId: ids[2]!,
    role: 'admin',
    status: 'pending',
    createdAt,
    updatedAt: t1,
    expiresAt,
    acceptedAt: null,
    revokedAt: null,
    version: 2,
    ...overrides,
  };
}

function restored(overrides: Partial<RestoreInvitationInput> = {}): Invitation {
  const result = Invitation.restore(restoreInput(overrides));
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function failureType(result: { ok: boolean }) {
  expect(result.ok).toBe(false);
  return (result as unknown as { error: { type: string } }).error.type;
}

describe('Invitation.issue', () => {
  it('issues each role as a pending, unsaved invitation', () => {
    for (const role of INVITATION_ROLES) {
      const result = issue({ role });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.id).toBe(ids[0]);
      expect(result.value.organizationId).toBe(ids[1]);
      expect(result.value.identityId).toBe(ids[2]);
      expect(result.value.role).toBe(role);
      expect(result.value.status).toBe('pending');
      expect(result.value.createdAt).toEqual(createdAt);
      expect(result.value.updatedAt).toEqual(createdAt);
      expect(result.value.acceptedAt).toBeNull();
      expect(result.value.revokedAt).toBeNull();
      expect(result.value.version).toBe(0);
    }
  });

  it('rejects unknown roles, including owner, with an invalid-kind failure', () => {
    for (const role of ['owner', 'guest', '', 1, null]) {
      const result = issue({ role });
      expect(failureType(result)).toBe('invitation.invalid_role');
      if (!result.ok) expect(result.error.kind).toBe('invalid');
    }
  });

  it('checks role before times', () => {
    expect(failureType(issue({ role: 'owner', createdAt: invalidDate }))).toBe(
      'invitation.invalid_role',
    );
  });

  it('rejects invalid creation or expiry times', () => {
    for (const overrides of [
      { createdAt: invalidDate },
      { expiresAt: invalidDate },
      { createdAt: dateLike },
      { expiresAt: dateLike },
    ]) {
      expect(failureType(issue(overrides))).toBe('invitation.invalid_time');
    }
  });

  it('requires expiry strictly after creation', () => {
    expect(failureType(issue({ expiresAt: createdAt }))).toBe(
      'invitation.invalid_expiry',
    );
    expect(
      failureType(issue({ expiresAt: new Date(createdAt.getTime() - 1) })),
    ).toBe('invitation.invalid_expiry');
    expect(issue({ expiresAt: new Date(createdAt.getTime() + 1) }).ok).toBe(true);
  });

  it('copies dates in and out', () => {
    const c = new Date(createdAt.getTime());
    const e = new Date(expiresAt.getTime());
    const result = issue({ createdAt: c, expiresAt: e });
    if (!result.ok) throw new Error(result.error.message);
    c.setTime(0);
    e.setTime(0);
    const invitation = result.value;
    expect(invitation.createdAt).toEqual(createdAt);
    expect(invitation.updatedAt).toEqual(createdAt);
    expect(invitation.expiresAt).toEqual(expiresAt);

    invitation.createdAt.setTime(0);
    invitation.updatedAt.setTime(0);
    invitation.expiresAt.setTime(0);
    expect(invitation.createdAt).toEqual(createdAt);
    expect(invitation.updatedAt).toEqual(createdAt);
    expect(invitation.expiresAt).toEqual(expiresAt);
  });
});

describe('Invitation.restore', () => {
  it('restores consistent pending, accepted and revoked states', () => {
    const p = restored();
    expect(p.status).toBe('pending');
    expect(p.role).toBe('admin');
    expect(p.version).toBe(2);
    expect(p.id).toBe(ids[0]);
    expect(p.organizationId).toBe(ids[1]);
    expect(p.identityId).toBe(ids[2]);
    expect(p.createdAt).toEqual(createdAt);
    expect(p.updatedAt).toEqual(t1);
    expect(p.expiresAt).toEqual(expiresAt);

    const a = restored({ status: 'accepted', acceptedAt: t1 });
    expect(a.status).toBe('accepted');
    expect(a.acceptedAt).toEqual(t1);
    expect(a.revokedAt).toBeNull();

    const r = restored({ status: 'revoked', revokedAt: t1 });
    expect(r.status).toBe('revoked');
    expect(r.revokedAt).toEqual(t1);
    expect(r.acceptedAt).toBeNull();
  });

  it('rejects malformed fields as invalid state', () => {
    const cases: Partial<RestoreInvitationInput>[] = [
      { role: 'owner' as InvitationRole },
      { status: 'expired' as InvitationStatus },
      { createdAt: invalidDate },
      { updatedAt: invalidDate },
      { expiresAt: invalidDate },
      { status: 'accepted', acceptedAt: invalidDate },
      { status: 'revoked', revokedAt: invalidDate },
      { version: 0 },
    ];
    for (const overrides of cases) {
      expect(failureType(Invitation.restore(restoreInput(overrides)))).toBe(
        'invitation.invalid_state',
      );
    }
  });

  it('rejects inconsistent status and terminal timestamps', () => {
    const cases: Partial<RestoreInvitationInput>[] = [
      { status: 'pending', acceptedAt: t1 },
      { status: 'pending', revokedAt: t1 },
      { status: 'accepted' },
      { status: 'accepted', acceptedAt: t1, revokedAt: t1 },
      { status: 'revoked' },
      { status: 'revoked', revokedAt: t1, acceptedAt: t1 },
    ];
    for (const overrides of cases) {
      expect(failureType(Invitation.restore(restoreInput(overrides)))).toBe(
        'invitation.invalid_state',
      );
    }
  });

  it('rejects update before creation and expiry not after creation', () => {
    expect(
      failureType(
        Invitation.restore(
          restoreInput({ updatedAt: new Date(createdAt.getTime() - 1) }),
        ),
      ),
    ).toBe('invitation.invalid_time');
    expect(
      failureType(Invitation.restore(restoreInput({ expiresAt: createdAt }))),
    ).toBe('invitation.invalid_time');
    expect(Invitation.restore(restoreInput({ updatedAt: createdAt })).ok).toBe(
      true,
    );
    expect(
      Invitation.restore(
        restoreInput({ expiresAt: new Date(createdAt.getTime() + 1) }),
      ).ok,
    ).toBe(true);
  });

  it('copies input dates, including terminal timestamps', () => {
    const at = new Date(t1.getTime());
    const u = new Date(t1.getTime());
    const accepted = Invitation.restore(
      restoreInput({ status: 'accepted', acceptedAt: at, updatedAt: u }),
    );
    if (!accepted.ok) throw new Error(accepted.error.message);
    at.setTime(0);
    u.setTime(0);
    expect(accepted.value.acceptedAt).toEqual(t1);
    expect(accepted.value.updatedAt).toEqual(t1);
    accepted.value.acceptedAt!.setTime(0);
    expect(accepted.value.acceptedAt).toEqual(t1);

    const rt = new Date(t1.getTime());
    const revoked = Invitation.restore(
      restoreInput({ status: 'revoked', revokedAt: rt }),
    );
    if (!revoked.ok) throw new Error(revoked.error.message);
    rt.setTime(0);
    expect(revoked.value.revokedAt).toEqual(t1);
    revoked.value.revokedAt!.setTime(0);
    expect(revoked.value.revokedAt).toEqual(t1);
  });
});

describe('Invitation.saved', () => {
  it('advances the version without changing state', () => {
    const invitation = restored({ status: 'accepted', acceptedAt: t1 });
    const saved = invitation.saved();
    expect(saved.version).toBe(3);
    expect(invitation.version).toBe(2);
    expect(saved.status).toBe('accepted');
    expect(saved.acceptedAt).toEqual(t1);
    expect(pending().saved().version).toBe(1);
  });
});

describe('Invitation.isExpired', () => {
  it('is true only for pending invitations at or after expiry with a valid time', () => {
    const invitation = pending();
    expect(invitation.isExpired(new Date(expiresAt.getTime() - 1))).toBe(false);
    expect(invitation.isExpired(expiresAt)).toBe(true);
    expect(invitation.isExpired(new Date(expiresAt.getTime() + 1))).toBe(true);
    expect(invitation.isExpired(invalidDate)).toBe(false);

    const later = new Date(expiresAt.getTime() + 1);
    expect(
      restored({ status: 'accepted', acceptedAt: t1 }).isExpired(later),
    ).toBe(false);
    expect(restored({ status: 'revoked', revokedAt: t1 }).isExpired(later)).toBe(
      false,
    );
  });
});

describe('Invitation transitions', () => {
  it('accept stamps acceptedAt and updatedAt, keeping everything else', () => {
    const invitation = restored({ version: 5 });
    const result = invitation.accept(t2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('accepted');
    expect(result.value.acceptedAt).toEqual(t2);
    expect(result.value.updatedAt).toEqual(t2);
    expect(result.value.revokedAt).toBeNull();
    expect(result.value.version).toBe(5);
    expect(result.value.role).toBe('admin');
    expect(result.value.createdAt).toEqual(createdAt);
    expect(result.value.expiresAt).toEqual(expiresAt);
    expect(result.value.organizationId).toBe(ids[1]);
    expect(invitation.status).toBe('pending');
    expect(invitation.acceptedAt).toBeNull();
  });

  it('accepts one millisecond before expiry', () => {
    expect(pending().accept(new Date(expiresAt.getTime() - 1)).ok).toBe(true);
  });

  it('revoke stamps revokedAt and updatedAt, even after expiry', () => {
    const invitation = restored({ version: 5 });
    const result = invitation.revoke(t2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('revoked');
    expect(result.value.revokedAt).toEqual(t2);
    expect(result.value.updatedAt).toEqual(t2);
    expect(result.value.acceptedAt).toBeNull();
    expect(result.value.version).toBe(5);
    expect(invitation.status).toBe('pending');

    expect(pending().revoke(new Date(expiresAt.getTime() + 1)).ok).toBe(true);
  });

  it('only pending invitations can be accepted or revoked', () => {
    const accepted = restored({ status: 'accepted', acceptedAt: t1 });
    const revoked = restored({ status: 'revoked', revokedAt: t1 });
    for (const invitation of [accepted, revoked]) {
      expect(failureType(invitation.accept(t2))).toBe('invitation.not_pending');
      expect(failureType(invitation.revoke(t2))).toBe('invitation.not_pending');
    }
    // Status is checked before expiry.
    expect(
      failureType(accepted.accept(new Date(expiresAt.getTime() + 1))),
    ).toBe('invitation.not_pending');
  });

  it('rejects invalid and backwards transition times before checking status', () => {
    const invitation = restored();
    const revoked = restored({ status: 'revoked', revokedAt: t1 });
    for (const run of [
      (i: Invitation, at: Date) => i.accept(at),
      (i: Invitation, at: Date) => i.revoke(at),
    ]) {
      expect(failureType(run(invitation, invalidDate))).toBe(
        'invitation.invalid_time',
      );
      expect(failureType(run(invitation, dateLike))).toBe(
        'invitation.invalid_time',
      );
      expect(failureType(run(invitation, new Date(t1.getTime() - 1)))).toBe(
        'invitation.non_monotonic_time',
      );
      expect(run(invitation, new Date(t1.getTime())).ok).toBe(true);
      expect(failureType(run(revoked, invalidDate))).toBe(
        'invitation.invalid_time',
      );
      expect(failureType(run(revoked, createdAt))).toBe(
        'invitation.non_monotonic_time',
      );
    }
  });

  it('copies the transition time into the new state', () => {
    const at = new Date(t2.getTime());
    const accepted = pending().accept(at);
    if (!accepted.ok) throw new Error(accepted.error.message);
    at.setTime(0);
    expect(accepted.value.acceptedAt).toEqual(t2);
    expect(accepted.value.updatedAt).toEqual(t2);

    const rt = new Date(t2.getTime());
    const revoked = pending().revoke(rt);
    if (!revoked.ok) throw new Error(revoked.error.message);
    rt.setTime(0);
    expect(revoked.value.revokedAt).toEqual(t2);
  });
});
