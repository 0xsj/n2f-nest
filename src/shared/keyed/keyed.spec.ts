import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { SecretString } from '../secret/index.js';
import { Digest } from './index.js';

const key = new SecretString('0123456789abcdef0123456789abcdef');
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));

describe('keyed digest', () => {
  it('binds purpose and reproduces a stable HMAC vector', () => {
    const digest = Digest.create(key);
    if (!digest.ok) throw new Error('fixture');
    const tag = digest.value.sign(
      'csrf',
      new TextEncoder().encode('session-digest-hex:0011'),
    );
    if (!tag.ok) throw new Error('fixture');
    expect(Buffer.from(tag.value).toString('hex')).toBe(
      'c29f3533287980e3ba89e4ab3ed87a1d87e928ae9109c38227f4008ca56d9672',
    );
    expect(
      digest.value.verify(
        'csrf',
        new TextEncoder().encode('session-digest-hex:0011'),
        tag.value,
      ),
    ).toEqual({
      ok: true,
      value: true,
    });
  });

  it('refuses invalid purposes and answers mismatches as false', () => {
    const digest = Digest.create(key);
    if (!digest.ok) throw new Error('fixture');
    const tag = digest.value.sign('csrf', bytes('message'));
    if (!tag.ok) throw new Error('fixture');

    expect(digest.value.verify('rate_limit', bytes('message'), tag.value)).toEqual({
      ok: true,
      value: false,
    });
    for (const purpose of ['', 'csrf token', 'csrfé', 'p'.repeat(65)]) {
      expect(digest.value.sign(purpose, bytes('message')).ok).toBe(false);
      expect(digest.value.verify(purpose, bytes('message'), tag.value).ok).toBe(
        false,
      );
    }
    expect(digest.value.verify('csrf', bytes('message'), tag.value.subarray(0, 31))).toEqual({
      ok: true,
      value: false,
    });
  });

  it('refuses short or missing keys and redacts the digest', () => {
    expect(Digest.create(new SecretString('short')).ok).toBe(false);
    expect(Digest.create(undefined as unknown as SecretString).ok).toBe(false);
    const digest = Digest.create(
      new SecretString('private-key-sentinel-' + 'x'.repeat(32)),
    );
    if (!digest.ok) throw new Error('fixture');
    for (const output of [
      String(digest.value),
      `${digest.value}`,
      JSON.stringify(digest.value),
      inspect(digest.value),
      JSON.stringify({ digest: digest.value }),
    ]) {
      expect(output).not.toContain('sentinel');
      expect(output).toContain('[REDACTED]');
    }
  });
});
