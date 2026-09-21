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
