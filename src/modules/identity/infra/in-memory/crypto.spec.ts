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

    expect(hashed.value.reveal()).toMatch(/^scrypt-v1\$/);
    expect((await codec.verify(password, hashed.value))).toEqual({ ok: true, value: true });
    expect((await codec.verify(wrongPassword, hashed.value))).toEqual({ ok: true, value: false });
    expect((await codec.verify(password, new SecretString('not-a-password-hash')))).toEqual({
      ok: true,
      value: false,
    });
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
