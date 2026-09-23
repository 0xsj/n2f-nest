import { describe, expect, it } from 'vitest';
import { parse } from '../../../shared/id/index.js';
import { Credential, normalizeEmail } from './credential.js';

const credentialId = parse('00000000-0000-7000-8000-000000000002');
const identityId = parse('00000000-0000-7000-8000-000000000001');

if (!credentialId.ok || !identityId.ok) {
  throw new Error('test IDs should be valid');
}

const id = credentialId.value;
const ownerId = identityId.value;
const createdAt = new Date('2026-09-19T00:00:00.000Z');

function emailPasswordCredential() {
  const result = Credential.createEmailPassword({
    id,
    identityId: ownerId,
    email: '  Artist@Example.com ',
    createdAt,
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.value;
}

describe('Credential', () => {
  it('normalizes an email/password credential', () => {
    const credential = emailPasswordCredential();

    expect(credential.id).toBe(id);
    expect(credential.identityId).toBe(ownerId);
    expect(credential.method).toBe('email_password');
    expect(credential.email).toBe('artist@example.com');
    expect(credential.status).toBe('active');
    expect(credential.createdAt).toEqual(createdAt);
    expect(credential.revokedAt).toBeNull();
    expect('passwordHash' in credential).toBe(false);
  });

  it('normalizes email addresses consistently', () => {
    const result = normalizeEmail('  FAN@Example.COM ');

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.value).toBe('fan@example.com');
  });

  it('rejects invalid email addresses', () => {
    const result = Credential.createEmailPassword({
      id,
      identityId: ownerId,
      email: 'not-an-email',
      createdAt,
    });

    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    expect(result.error.type).toBe('credential.invalid_email');
  });

  it('revokes immutably', () => {
    const credential = emailPasswordCredential();
    const revokedAt = new Date('2026-09-19T00:05:00.000Z');

    const result = credential.revoke(revokedAt);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(credential.status).toBe('active');
    expect(result.value.status).toBe('revoked');
    expect(result.value.updatedAt).toEqual(revokedAt);
    expect(result.value.revokedAt).toEqual(revokedAt);
  });

  it('rejects revoking an already-revoked credential', () => {
    const credential = emailPasswordCredential();
    const revoked = credential.revoke(
      new Date('2026-09-19T00:05:00.000Z'),
    );

    expect(revoked.ok).toBe(true);

    if (!revoked.ok) {
      return;
    }

    const result = revoked.value.revoke(
      new Date('2026-09-19T00:06:00.000Z'),
    );

    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    expect(result.error.type).toBe('credential.already_revoked');
  });

  it('rejects a revocation time that moves backwards', () => {
    const credential = emailPasswordCredential();

    const result = credential.revoke(
      new Date('2026-09-18T23:59:00.000Z'),
    );

    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    expect(result.error.type).toBe('credential.non_monotonic_time');
  });
});

describe('Credential invariants', () => {
  const at = (minutes: number) =>
    new Date(createdAt.getTime() + minutes * 60 * 1000);

  function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  const restoreBase = {
    id,
    identityId: ownerId,
    method: 'email_password' as const,
    email: 'fan@example.com',
    status: 'active' as const,
    createdAt,
    updatedAt: at(1),
    revokedAt: null,
  };

  it('accepts only well-formed addresses of at most 254 characters', () => {
    const domain = '@example.com';
    const longest = 'a'.repeat(254 - domain.length) + domain;

    expect(normalizeEmail(longest)).toEqual({ ok: true, value: longest });
    expect(normalizeEmail(`  ${longest}  `).ok).toBe(true);
    for (const input of [
      `a${longest}`,
      '',
      '   ',
      'fan@example',
      '@example.com',
      'fan@.com',
      'fan@example.',
      'f an@example.com',
      'fan@exa mple.com',
      'fan@@example.com',
      'x fan@example.com',
      'fan@example.com x',
      42,
      null,
      undefined,
    ]) {
      expect(normalizeEmail(input), String(input)).toMatchObject({
        ok: false,
        error: { kind: 'invalid', type: 'credential.invalid_email' },
      });
    }
  });

  it('refuses an invalid creation time before looking at the email', () => {
    expect(
      Credential.createEmailPassword({
        id,
        identityId: ownerId,
        email: 'not-an-email',
        createdAt: new Date(Number.NaN),
      }),
    ).toMatchObject({
      ok: false,
      error: { kind: 'invalid', type: 'credential.invalid_created_at' },
    });
    expect(
      Credential.createEmailPassword({
        id,
        identityId: ownerId,
        email: 'fan@example.com',
        createdAt: createdAt.toISOString() as unknown as Date,
      }),
    ).toMatchObject({ ok: false, error: { type: 'credential.invalid_created_at' } });
  });

  it('owns copies of its dates', () => {
    const input = new Date(createdAt.getTime());
    const credential = unwrap(
      Credential.createEmailPassword({ id, identityId: ownerId, email: 'fan@example.com', createdAt: input }),
    );
    input.setTime(0);

    expect(credential.createdAt).toEqual(createdAt);
    expect(credential.updatedAt).toEqual(createdAt);
    credential.createdAt.setTime(0);
    credential.updatedAt.setTime(0);
    expect(credential.createdAt).toEqual(createdAt);
    expect(credential.updatedAt).toEqual(createdAt);

    const time = at(5);
    const revoked = unwrap(credential.revoke(time));
    time.setTime(0);
    revoked.revokedAt!.setTime(0);
    revoked.updatedAt.setTime(0);
    expect(revoked.revokedAt).toEqual(at(5));
    expect(revoked.updatedAt).toEqual(at(5));
  });

  it('keeps ownership and email through revocation', () => {
    const revoked = unwrap(emailPasswordCredential().revoke(createdAt));

    expect(revoked.id).toBe(id);
    expect(revoked.identityId).toBe(ownerId);
    expect(revoked.method).toBe('email_password');
    expect(revoked.email).toBe('artist@example.com');
    expect(revoked.createdAt).toEqual(createdAt);
    expect(revoked.revokedAt).toEqual(createdAt);
  });

  it('refuses an invalid revocation time and checks time before status', () => {
    const credential = emailPasswordCredential();
    expect(credential.revoke(new Date(Number.NaN))).toMatchObject({
      ok: false,
      error: { kind: 'invalid', type: 'credential.invalid_revocation_time' },
    });

    const revoked = unwrap(credential.revoke(at(5)));
    expect(revoked.revoke(at(4))).toMatchObject({
      ok: false,
      error: { type: 'credential.non_monotonic_time' },
    });
    expect(revoked.revoke(at(5))).toMatchObject({
      ok: false,
      error: { kind: 'invalid', type: 'credential.already_revoked' },
    });
  });

  it('restores stored state as normalized copies', () => {
    const created = new Date(createdAt.getTime());
    const updated = at(1);
    const credential = unwrap(
      Credential.restore({ ...restoreBase, email: ' FAN@Example.com', createdAt: created, updatedAt: updated }),
    );
    created.setTime(0);
    updated.setTime(0);

    expect(credential.id).toBe(id);
    expect(credential.identityId).toBe(ownerId);
    expect(credential.method).toBe('email_password');
    expect(credential.email).toBe('fan@example.com');
    expect(credential.status).toBe('active');
    expect(credential.createdAt).toEqual(createdAt);
    expect(credential.updatedAt).toEqual(at(1));
    expect(credential.revokedAt).toBeNull();

    const revokedAt = at(1);
    const revoked = unwrap(
      Credential.restore({ ...restoreBase, status: 'revoked', revokedAt }),
    );
    revokedAt.setTime(0);
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedAt).toEqual(at(1));
    expect(Credential.restore({ ...restoreBase, updatedAt: createdAt }).ok).toBe(true);
  });

  it('refuses malformed stored state', () => {
    for (const patch of [
      { method: 'passkey' as never },
      { status: 'deleted' as never },
      { createdAt: new Date(Number.NaN) },
      { updatedAt: new Date(Number.NaN) },
      { status: 'revoked' as const, revokedAt: new Date(Number.NaN) },
      { revokedAt: at(1) },
      { status: 'revoked' as const, revokedAt: null },
    ]) {
      expect(Credential.restore({ ...restoreBase, ...patch }), JSON.stringify(patch)).toMatchObject({
        ok: false,
        error: { kind: 'invalid', type: 'credential.invalid_state' },
      });
    }
    expect(Credential.restore({ ...restoreBase, email: 'nope' })).toMatchObject({
      ok: false,
      error: { type: 'credential.invalid_email' },
    });
    expect(
      Credential.restore({ ...restoreBase, updatedAt: new Date(createdAt.getTime() - 1) }),
    ).toMatchObject({
      ok: false,
      error: { kind: 'invalid', type: 'credential.non_monotonic_time' },
    });
  });
});
