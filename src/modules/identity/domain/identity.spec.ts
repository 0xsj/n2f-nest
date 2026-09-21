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
