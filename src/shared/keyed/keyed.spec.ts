import { inspect } from 'node:util';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { SecretString } from '../secret/index.js';
import { Digest } from './index.js';
import type { Failure, Result } from '../errors/index.js';

type Vectors = {
  vectors: {
    name: string;
    key_hex: string;
    purpose: string;
    message_hex: string;
    tag_hex: string;
  }[];
  purpose_rejects: { name: string; purpose: string }[];
  short_key_hex: string;
};
const fixture = JSON.parse(
  readFileSync(new URL('./testdata/vectors.json', import.meta.url), 'utf8'),
) as Vectors;
const value = <T>(r: Result<T, Failure>): T => {
  if (!r.ok) throw new Error('expected success: ' + r.error.type);
  return r.value;
};
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
/** The key travels as secret text; only byte sequences that are valid UTF-8 are representable. */
const keyText = (hex: string): string | undefined => {
  const raw = Buffer.from(hex, 'hex');
  const text = raw.toString('utf8');
  return Buffer.from(text, 'utf8').equals(raw) ? text : undefined;
};
const digestFor = (hex: string) =>
  value(Digest.create(new SecretString(keyText(hex)!)));

describe('keyed digest (K01–K05)', () => {
  it('reproduces every vector; keys are UTF-8 text (K01)', () => {
    let unrepresentable = 0;
    for (const v of fixture.vectors) {
      if (keyText(v.key_hex) === undefined) {
        unrepresentable++;
        continue;
      }
      const d = digestFor(v.key_hex);
      const tag = value(d.sign(v.purpose, bytes(v.message_hex)));
      expect(Buffer.from(tag).toString('hex'), v.name).toBe(v.tag_hex);
      expect(
        value(d.verify(v.purpose, bytes(v.message_hex), bytes(v.tag_hex))),
        v.name,
      ).toBe(true);
    }
    expect(unrepresentable).toBe(0);
  });
  it('binds the purpose and refuses invalid purposes', () => {
    const d = digestFor(fixture.vectors[0].key_hex);
    const message = bytes(fixture.vectors[0].message_hex);
    const a = value(d.sign('csrf', message)),
      b = value(d.sign('rate_limit', message));
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).not.toBe(0);
    expect(a.length).toBe(32);
    for (const r of fixture.purpose_rejects) {
      const signed = d.sign(r.purpose, message);
      expect(signed.ok, r.name).toBe(false);
      if (!signed.ok) expect(signed.error.type).toBe('keyed.purpose_invalid');
      const verified = d.verify(r.purpose, message, a);
      expect(verified.ok, r.name).toBe(false);
    }
  });
  it('verifies in constant time and answers false as a value', () => {
    const d = digestFor(fixture.vectors[0].key_hex);
    const message = bytes(fixture.vectors[0].message_hex);
    const tag = value(d.sign('csrf', message));
    const wrong = new Uint8Array(tag);
    wrong[0] ^= 1;
    expect(value(d.verify('csrf', message, wrong))).toBe(false);
    expect(value(d.verify('csrf', message, tag.subarray(0, 31)))).toBe(false);
    expect(value(d.verify('csrf', message, new Uint8Array(33)))).toBe(false);
    expect(value(d.verify('rate_limit', message, tag))).toBe(false);
    expect(value(d.verify('csrf', bytes('00'), tag))).toBe(false);
    expect(value(d.verify('csrf', message, tag))).toBe(true);
  });
  it('refuses a short or missing key and never discloses the key', () => {
    const short = Digest.create(
      new SecretString(keyText(fixture.short_key_hex)!),
    );
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.error.type).toBe('keyed.configuration');
    expect(Digest.create(undefined as unknown as SecretString).ok).toBe(false);
    expect(Digest.create('0'.repeat(64) as unknown as SecretString).ok).toBe(
      false,
    );
    const d = value(
      Digest.create(new SecretString('private-key-sentinel-' + 'x'.repeat(32))),
    );
    for (const out of [
      String(d),
      `${d}`,
      JSON.stringify(d),
      inspect(d),
      JSON.stringify({ d }),
    ]) {
      expect(out).not.toContain('sentinel');
      expect(out).toContain('[REDACTED]');
    }
  });
});
