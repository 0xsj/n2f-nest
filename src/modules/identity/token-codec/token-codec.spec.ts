import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import type { Result, Failure } from '../../../shared/errors/index.js';
import { SecretString } from '../../../shared/secret/index.js';
import { TokenDigest, type TokenPurpose } from '../domain/token.js';
import { TokenCodec } from './index.js';

type Vectors = {
  secret_length: number;
  tokens: {
    purpose: TokenPurpose;
    name: string;
    secret: string;
    digest_hex: string;
  }[];
  rejects: { name: string; secret: string }[];
};
const vectors = JSON.parse(
  readFileSync(new URL('./testdata/vectors.json', import.meta.url), 'utf8'),
) as Vectors;
const value = <T>(r: Result<T, Failure>): T => {
  if (!r.ok) throw Error('expected success: ' + r.error.type);
  return r.value;
};
const refusal = <T>(r: Result<T, Failure>, kind: string, type: string) => {
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.error.kind).toBe(kind);
    expect(r.error.type).toBe(type);
  }
};
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const osEntropy = (bytes: Uint8Array) => {
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff;
};
const purposes: TokenPurpose[] = [
  'session',
  'email_verification',
  'password_reset',
  'websocket_upgrade',
];

for (const t of vectors.tokens)
  it(`digest vector ${t.purpose}/${t.name}`, () => {
    const codec = value(TokenCodec.create(osEntropy));
    const d = value(codec.digest(t.purpose, new SecretString(t.secret)));
    expect(TokenDigest.valid(d)).toBe(true);
    expect(d.purpose()).toBe(t.purpose);
    expect(hex(d.bytes())).toBe(t.digest_hex);
    expect(t.secret.length).toBe(vectors.secret_length);
  });

for (const r of vectors.rejects)
  it('rejects non-canonical secret ' + r.name, () => {
    const codec = value(TokenCodec.create(osEntropy));
    for (const p of purposes)
      refusal(
        codec.digest(p, new SecretString(r.secret)),
        'invalid',
        'identity.token_invalid',
      );
  });

it('issues from injected entropy and round-trips through digest', () => {
  const seq = vectors.tokens.find(
    (t) => t.purpose === 'session' && t.name === 'sequence',
  )!;
  const codec = value(
    TokenCodec.create((bytes) => {
      for (let i = 0; i < bytes.length; i++) bytes[i] = i;
    }),
  );
  const issued = value(codec.issue('session'));
  expect(issued.secret).toBeInstanceOf(SecretString);
  expect(issued.secret.reveal()).toBe(seq.secret);
  expect(hex(issued.digest.bytes())).toBe(seq.digest_hex);
  expect(issued.digest.purpose()).toBe('session');
  const again = value(codec.digest('session', issued.secret));
  expect(hex(again.bytes())).toBe(hex(issued.digest.bytes()));
  for (const shown of [
    JSON.stringify(issued),
    inspect(issued),
    String(issued.secret),
    String(issued.digest),
  ]) {
    expect(shown).toContain('[REDACTED]');
    expect(shown).not.toContain(seq.secret);
    expect(shown).not.toContain(seq.digest_hex);
  }
});

it('issues distinct canonical secrets and binds digests to purpose', () => {
  let n = 0;
  const codec = value(
    TokenCodec.create((bytes) => {
      n++;
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + n) & 0xff;
    }),
  );
  const a = value(codec.issue('email_verification'));
  const b = value(codec.issue('email_verification'));
  expect(a.secret.reveal()).not.toBe(b.secret.reveal());
  for (const s of [a.secret.reveal(), b.secret.reveal()]) {
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(s, 'base64url').toString('base64url')).toBe(s);
  }
  const seen = new Set<string>();
  for (const p of purposes)
    seen.add(hex(value(codec.digest(p, a.secret)).bytes()));
  expect(seen.size).toBe(purposes.length);
});

it('refuses invalid purpose, entropy failure and configuration', () => {
  let calls = 0;
  const failing = value(
    TokenCodec.create(() => {
      calls++;
      throw new Error('entropy down');
    }),
  );
  refusal(
    failing.issue('session'),
    'unavailable',
    'identity.entropy_unavailable',
  );
  expect(calls).toBe(1);
  const codec = value(TokenCodec.create(osEntropy));
  refusal(
    codec.issue('SESSION' as TokenPurpose),
    'invalid',
    'identity.token_invalid',
  );
  refusal(
    codec.digest(
      'access' as TokenPurpose,
      new SecretString(vectors.tokens[0].secret),
    ),
    'invalid',
    'identity.token_invalid',
  );
  refusal(
    codec.digest(
      'session',
      vectors.tokens[0].secret as unknown as SecretString,
    ),
    'invalid',
    'identity.token_invalid',
  );
  refusal(
    TokenCodec.create(undefined as unknown as () => void),
    'invalid',
    'identity.token_codec_configuration',
  );
  refusal(
    TokenCodec.create('os' as unknown as () => void),
    'invalid',
    'identity.token_codec_configuration',
  );
});
