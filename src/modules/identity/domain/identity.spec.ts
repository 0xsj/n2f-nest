import { describe, expect, it } from 'vitest';
import { parse } from '../../../shared/id/index.js';
import { Identity } from './identity.js';

const identityId = parse('00000000-0000-7000-8000-000000000001');

if (!identityId.ok) {
  throw new Error('test identity ID should be valid');
}

const id = identityId.value;
const registeredAt = new Date('2026-09-19T00:00:00.000Z');

function registeredIdentity() {
  const result = Identity.register({
    id,
    createdAt: registeredAt,
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.value;
}

describe('Identity', () => {
  it('registers in pending verification state', () => {
    const identity = registeredIdentity();

    expect(identity.id).toBe(id);
    expect(identity.status).toBe('pending_verification');
    expect(identity.createdAt).toEqual(registeredAt);
    expect(identity.updatedAt).toEqual(registeredAt);
    expect(identity.verifiedAt).toBeNull();
  });

  it('verifies a pending identity without mutating the original', () => {
    const identity = registeredIdentity();
    const verifiedAt = new Date('2026-09-19T00:01:00.000Z');

    const result = identity.verify(verifiedAt);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(identity.status).toBe('pending_verification');
    expect(result.value.status).toBe('active');
    expect(result.value.verifiedAt).toEqual(verifiedAt);
    expect(result.value.updatedAt).toEqual(verifiedAt);
  });

  it('rejects verification after the identity is no longer pending', () => {
    const identity = registeredIdentity();
    const verified = identity.verify(
      new Date('2026-09-19T00:01:00.000Z'),
    );

    expect(verified.ok).toBe(true);

    if (!verified.ok) {
      return;
    }

    const result = verified.value.verify(
      new Date('2026-09-19T00:02:00.000Z'),
    );

    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    expect(result.error.type).toBe('identity.invalid_verification');
  });

  it('supports suspension and reactivation', () => {
    const verified = registeredIdentity().verify(
      new Date('2026-09-19T00:01:00.000Z'),
    );

    expect(verified.ok).toBe(true);

    if (!verified.ok) {
      return;
    }

    const suspended = verified.value.suspend(
      new Date('2026-09-19T00:02:00.000Z'),
    );

    expect(suspended.ok).toBe(true);

    if (!suspended.ok) {
      return;
    }

    expect(suspended.value.status).toBe('suspended');

    const reactivated = suspended.value.reactivate(
      new Date('2026-09-19T00:03:00.000Z'),
    );

    expect(reactivated.ok).toBe(true);

    if (!reactivated.ok) {
      return;
    }

    expect(reactivated.value.status).toBe('active');
  });

  it('makes disabled identities terminal', () => {
    const identity = registeredIdentity();
    const disabled = identity.disable(
      new Date('2026-09-19T00:01:00.000Z'),
    );

    expect(disabled.ok).toBe(true);

    if (!disabled.ok) {
      return;
    }

    expect(disabled.value.status).toBe('disabled');

    const result = disabled.value.reactivate(
      new Date('2026-09-19T00:02:00.000Z'),
    );

    expect(result.ok).toBe(false);
  });

  it('rejects time moving backwards', () => {
    const identity = registeredIdentity();

    const result = identity.verify(
      new Date('2026-09-18T23:59:00.000Z'),
    );

    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    expect(result.error.type).toBe('identity.non_monotonic_time');
  });
});

describe('Identity invariants', () => {
  const at = (minutes: number) =>
    new Date(registeredAt.getTime() + minutes * 60 * 1000);
  const verifiedAt = at(1);

  function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  const restoreBase = {
    id,
    status: 'active' as const,
    createdAt: registeredAt,
    updatedAt: at(2),
    verifiedAt,
    version: 3,
  };

  it('refuses an invalid creation time', () => {
    for (const createdAt of [new Date(Number.NaN), 'nope' as unknown as Date]) {
      expect(Identity.register({ id, createdAt })).toMatchObject({
        ok: false,
        error: { kind: 'invalid', type: 'identity.invalid_created_at' },
      });
    }
  });

  it('starts unsaved and owns copies of its dates', () => {
    const input = new Date(registeredAt.getTime());
    const identity = unwrap(Identity.register({ id, createdAt: input }));
    input.setTime(0);

    expect(identity.version).toBe(0);
    expect(identity.createdAt).toEqual(registeredAt);
    expect(identity.updatedAt).toEqual(registeredAt);

    identity.createdAt.setTime(0);
    identity.updatedAt.setTime(0);
    expect(identity.createdAt).toEqual(registeredAt);
    expect(identity.updatedAt).toEqual(registeredAt);

    const verified = unwrap(identity.verify(verifiedAt));
    verified.verifiedAt!.setTime(0);
    expect(verified.verifiedAt).toEqual(verifiedAt);
  });

  it('copies the transition time instead of aliasing it', () => {
    const time = new Date(verifiedAt.getTime());
    const verified = unwrap(registeredIdentity().verify(time));
    time.setTime(0);

    expect(verified.updatedAt).toEqual(verifiedAt);
    expect(verified.verifiedAt).toEqual(verifiedAt);
  });

  it('advances the version only when saved', () => {
    const identity = registeredIdentity();
    const saved = identity.saved();

    expect(saved).not.toBe(identity);
    expect(identity.version).toBe(0);
    expect(saved.version).toBe(1);
    expect(saved.saved().version).toBe(2);
    expect(saved.status).toBe('pending_verification');
    expect(saved.createdAt).toEqual(registeredAt);

    const verified = unwrap(saved.verify(verifiedAt));
    expect(verified.version).toBe(1);
    expect(unwrap(verified.suspend(at(2))).version).toBe(1);
    expect(unwrap(verified.disable(at(2))).version).toBe(1);
  });

  it('accepts a transition at the current update time', () => {
    expect(registeredIdentity().verify(registeredAt).ok).toBe(true);
  });

  it('refuses invalid transition times before checking status', () => {
    const disabled = unwrap(registeredIdentity().disable(at(5)));
    for (const transition of ['verify', 'suspend', 'disable', 'reactivate'] as const) {
      expect(disabled[transition](new Date(Number.NaN))).toMatchObject({
        ok: false,
        error: { kind: 'invalid', type: 'identity.invalid_transition_time' },
      });
      expect(disabled[transition](at(4))).toMatchObject({
        ok: false,
        error: { kind: 'invalid', type: 'identity.non_monotonic_time' },
      });
    }
  });

  it('refuses transitions from the wrong status', () => {
    const pending = registeredIdentity();
    const active = unwrap(pending.verify(verifiedAt));

    expect(pending.suspend(at(2))).toMatchObject({
      ok: false,
      error: { kind: 'invalid', type: 'identity.invalid_suspension' },
    });
    expect(pending.reactivate(at(2))).toMatchObject({
      ok: false,
      error: { kind: 'invalid', type: 'identity.invalid_reactivation' },
    });
    expect(active.reactivate(at(2))).toMatchObject({
      ok: false,
      error: { type: 'identity.invalid_reactivation' },
    });
    const suspended = unwrap(active.suspend(at(2)));
    expect(suspended.suspend(at(3))).toMatchObject({
      ok: false,
      error: { type: 'identity.invalid_suspension' },
    });
    expect(suspended.verify(at(3))).toMatchObject({
      ok: false,
      error: { type: 'identity.invalid_verification' },
    });
    const disabled = unwrap(suspended.disable(at(3)));
    expect(disabled.disable(at(4))).toMatchObject({
      ok: false,
      error: { kind: 'invalid', type: 'identity.already_disabled' },
    });
  });

  it('keeps identity, creation and verification through transitions', () => {
    const active = unwrap(registeredIdentity().verify(verifiedAt));
    const suspended = unwrap(active.suspend(at(2)));
    const reactivated = unwrap(suspended.reactivate(at(3)));
    const disabled = unwrap(reactivated.disable(at(4)));

    for (const [identity, updatedAt] of [
      [suspended, at(2)],
      [reactivated, at(3)],
      [disabled, at(4)],
    ] as const) {
      expect(identity.id).toBe(id);
      expect(identity.createdAt).toEqual(registeredAt);
      expect(identity.updatedAt).toEqual(updatedAt);
      expect(identity.verifiedAt).toEqual(verifiedAt);
    }
    expect(suspended.status).toBe('suspended');
    expect(active.status).toBe('active');
    expect(active.updatedAt).toEqual(verifiedAt);
    expect(disabled.status).toBe('disabled');

    const disabledPending = unwrap(registeredIdentity().disable(at(1)));
    expect(disabledPending.verifiedAt).toBeNull();
    expect(disabledPending.updatedAt).toEqual(at(1));
  });

  it('restores stored state as copies', () => {
    const createdAt = new Date(registeredAt.getTime());
    const updatedAt = at(2);
    const verified = new Date(verifiedAt.getTime());
    const identity = unwrap(
      Identity.restore({ ...restoreBase, createdAt, updatedAt, verifiedAt: verified }),
    );
    createdAt.setTime(0);
    updatedAt.setTime(0);
    verified.setTime(0);

    expect(identity.id).toBe(id);
    expect(identity.status).toBe('active');
    expect(identity.version).toBe(3);
    expect(identity.createdAt).toEqual(registeredAt);
    expect(identity.updatedAt).toEqual(at(2));
    expect(identity.verifiedAt).toEqual(verifiedAt);
  });

  it('restores every consistent status', () => {
    expect(
      Identity.restore({ ...restoreBase, status: 'pending_verification', verifiedAt: null }).ok,
    ).toBe(true);
    expect(Identity.restore({ ...restoreBase, status: 'suspended' }).ok).toBe(true);
    expect(Identity.restore({ ...restoreBase, status: 'disabled' }).ok).toBe(true);
    expect(
      Identity.restore({ ...restoreBase, status: 'disabled', verifiedAt: null }),
    ).toMatchObject({ ok: true, value: { verifiedAt: null } });
    expect(Identity.restore({ ...restoreBase, updatedAt: registeredAt }).ok).toBe(true);
  });

  it('refuses malformed stored state', () => {
    for (const patch of [
      { status: 'deleted' as never },
      { createdAt: new Date(Number.NaN) },
      { updatedAt: new Date(Number.NaN) },
      { verifiedAt: new Date(Number.NaN) },
      { version: 0 },
      { version: 1.5 },
    ]) {
      expect(Identity.restore({ ...restoreBase, ...patch }), JSON.stringify(patch)).toMatchObject({
        ok: false,
        error: { kind: 'invalid', type: 'identity.invalid_state' },
      });
    }
  });

  it('refuses an update before creation', () => {
    expect(
      Identity.restore({ ...restoreBase, updatedAt: new Date(registeredAt.getTime() - 1) }),
    ).toMatchObject({
      ok: false,
      error: { kind: 'invalid', type: 'identity.non_monotonic_time' },
    });
  });

  it('refuses verification state that contradicts the status', () => {
    for (const patch of [
      { status: 'pending_verification' as const },
      { status: 'active' as const, verifiedAt: null },
      { status: 'suspended' as const, verifiedAt: null },
    ]) {
      expect(Identity.restore({ ...restoreBase, ...patch }), JSON.stringify(patch)).toMatchObject({
        ok: false,
        error: { kind: 'invalid', type: 'identity.invalid_state' },
      });
    }
  });
});
