import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretString } from '../../../../shared/secret/index.js';
import { NodePasswordCodec, NodeTokenCodec } from './crypto.js';

describe('Identity crypto adapters', () => {
  it('hashes passwords and verifies only the matching secret', async () => {
    const codec = new NodePasswordCodec();
    const password = new SecretString('correct horse battery staple');
    const wrongPassword = new SecretString('incorrect horse battery staple');

    const hashed = await codec.hash(password);

    expect(hashed.ok).toBe(true);

    if (!hashed.ok) {
      return;
    }

    expect(hashed.value.reveal()).toMatch(/^scrypt-v2\$32768\$8\$3\$/);
    expect((await codec.verify(password, hashed.value))).toEqual({ ok: true, value: true });
    expect((await codec.verify(wrongPassword, hashed.value))).toEqual({ ok: true, value: false });
    expect((await codec.verify(password, new SecretString('not-a-password-hash')))).toEqual({
      ok: true,
      value: false,
    });
  });

  it('still verifies scrypt-v1 hashes created before the cost was raised', async () => {
    const salt = randomBytes(16);
    const digest = scryptSync('correct horse battery staple', salt, 32, { N: 16384, r: 8, p: 1 });
    const legacy = new SecretString(`scrypt-v1$${salt.toString('base64url')}$${digest.toString('base64url')}`);
    const codec = new NodePasswordCodec();

    expect(await codec.verify(new SecretString('correct horse battery staple'), legacy)).toEqual({ ok: true, value: true });
    expect(await codec.verify(new SecretString('wrong'), legacy)).toEqual({ ok: true, value: false });
  });

  it('refuses a stored hash whose cost would exhaust the verifier', async () => {
    const salt = randomBytes(16).toString('base64url');
    const digest = randomBytes(32).toString('base64url');
    const hostile = new SecretString(`scrypt-v2$1073741824$8$1$${salt}$${digest}`);

    expect(await new NodePasswordCodec().verify(new SecretString('anything'), hostile)).toEqual({
      ok: true,
      value: false,
    });
  });

  it('verifies a decoy that matches no password', async () => {
    const codec = new NodePasswordCodec();
    expect(await codec.verifyDecoy(new SecretString('correct horse battery staple'))).toEqual({ ok: true, value: false });
    expect(await codec.verifyDecoy(new SecretString(''))).toEqual({ ok: true, value: false });
  });

  it('issues opaque token material and verifies its digest', async () => {
    const codec = new NodeTokenCodec();
    const issued = await codec.issue();

    expect(issued.ok).toBe(true);

    if (!issued.ok) {
      return;
    }

    expect(issued.value.token.reveal()).not.toBe(issued.value.digest.reveal());
    expect(await codec.verify(issued.value.token, issued.value.digest)).toEqual({
      ok: true,
      value: true,
    });
    expect(await codec.verify(new SecretString(`${issued.value.token.reveal()}-tampered`), issued.value.digest)).toEqual({
      ok: true,
      value: false,
    });
  });
});
