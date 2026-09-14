import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import type { Result, Failure } from '../../../shared/errors/index.js';
import { SecretString } from '../../../shared/secret/index.js';
import { NewPassword, PasswordInput } from '../domain/password.js';
import { PasswordHasher, type Limits, type Outcome } from './index.js';
import { createHasher, type Derive } from './hasher.js';

type Vectors = {
  dummy_record: string;
  hashes: { name: string; password: string; salt_hex: string; phc: string }[];
  verify: { name: string; record: string; password: string; outcome: string }[];
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
const limits: Limits = { maxConcurrent: 2, maxQueued: 4, queueWaitMs: 5000 };
const fixedEntropy = (hex: string) => (bytes: Uint8Array) => {
  bytes.set(Buffer.from(hex, 'hex').subarray(0, bytes.length));
};
const osEntropy = (bytes: Uint8Array) => {
  bytes.set(Buffer.alloc(bytes.length, 7));
};
const newPassword = (s: string) =>
  value(NewPassword.parse(new SecretString(s)));
const input = (s: string) => value(PasswordInput.parse(new SecretString(s)));
const record = (s: string) => new SecretString(s);
const dummyPassword = 'n2f-absent-credential-dummy-2026-09-12';

for (const h of vectors.hashes)
  it('reproduces fixture hash ' + h.name, async () => {
    const hasher = value(
      PasswordHasher.create(fixedEntropy(h.salt_hex), limits),
    );
    const hash = await hasher.hash(newPassword(h.password));
    const out = value(hash);
    expect(out).toBeInstanceOf(SecretString);
    expect(out.reveal()).toBe(h.phc);
    for (const shown of [String(out), JSON.stringify(out), inspect(out)]) {
      expect(shown).toContain('[REDACTED]');
      expect(shown).not.toContain('argon2');
    }
  });

for (const v of vectors.verify)
  it('verify fixture ' + v.name, async () => {
    const hasher = value(PasswordHasher.create(osEntropy, limits));
    const r = await hasher.verify(input(v.password), record(v.record));
    if (v.outcome === 'corrupt') {
      refusal(r, 'internal', 'identity.credential_corrupt');
      refusal(
        hasher.needsRehash(record(v.record)),
        'internal',
        'identity.credential_corrupt',
      );
    } else {
      expect(value(r)).toBe(v.outcome as Outcome);
      expect(value(hasher.needsRehash(record(v.record)))).toBe(false);
    }
  });

it('absent verification always mismatches while the dummy record is real', async () => {
  const hasher = value(PasswordHasher.create(osEntropy, limits));
  expect(
    value(
      await hasher.verify(input(dummyPassword), record(vectors.dummy_record)),
    ),
  ).toBe('match');
  expect(value(await hasher.verifyAbsent(input(dummyPassword)))).toBe(
    'mismatch',
  );
  expect(value(await hasher.verifyAbsent(input('anything else at all')))).toBe(
    'mismatch',
  );
});

it('entropy failure refuses hashing without a fallback salt', async () => {
  let calls = 0;
  const hasher = value(
    PasswordHasher.create(() => {
      calls++;
      throw new Error('no entropy');
    }, limits),
  );
  refusal(
    await hasher.hash(newPassword('correct horse battery staple')),
    'unavailable',
    'identity.entropy_unavailable',
  );
  expect(calls).toBe(1);
  // Verification never needs entropy.
  expect(
    value(
      await hasher.verify(
        input(vectors.hashes[0].password),
        record(vectors.hashes[0].phc),
      ),
    ),
  ).toBe('match');
});

it('refuses configuration and forged arguments', async () => {
  const bad: Limits[] = [
    { maxConcurrent: 0, maxQueued: 0, queueWaitMs: 1 },
    { maxConcurrent: 1.5, maxQueued: 0, queueWaitMs: 1 },
    { maxConcurrent: 1, maxQueued: -1, queueWaitMs: 1 },
    { maxConcurrent: 1, maxQueued: 0, queueWaitMs: 0 },
    { maxConcurrent: 1, maxQueued: 0, queueWaitMs: Number.NaN },
  ];
  for (const l of bad)
    refusal(
      PasswordHasher.create(osEntropy, l),
      'invalid',
      'identity.hasher_configuration',
    );
  refusal(
    PasswordHasher.create(undefined as unknown as () => void, limits),
    'invalid',
    'identity.hasher_configuration',
  );
  const hasher = value(PasswordHasher.create(osEntropy, limits));
  refusal(
    await hasher.hash({
      secret: () => new SecretString('x'.repeat(20)),
    } as unknown as NewPassword),
    'invalid',
    'identity.password_invalid',
  );
  refusal(
    await hasher.verify(
      { secret: () => new SecretString('x') } as unknown as PasswordInput,
      record(vectors.hashes[0].phc),
    ),
    'invalid',
    'identity.password_invalid',
  );
  refusal(
    await hasher.verify(input('x'), 'not a secret' as unknown as SecretString),
    'internal',
    'identity.credential_corrupt',
  );
  refusal(
    hasher.needsRehash({} as SecretString),
    'internal',
    'identity.credential_corrupt',
  );
});

type Gate = {
  promise: Promise<Uint8Array>;
  resolve: (b: Uint8Array) => void;
  reject: (e: unknown) => void;
};
const gate = (): Gate => {
  let resolve!: (b: Uint8Array) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<Uint8Array>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const goodTag = Buffer.from(vectors.hashes[0].phc.split('$')[5], 'base64');
const tick = () => new Promise((r) => setTimeout(r, 0));
const seam = (derive: Derive, l: Limits) =>
  value(createHasher(derive, osEntropy, l));
const verifyGood = (h: ReturnType<typeof seam>, signal?: AbortSignal) =>
  h.verify(input(vectors.hashes[0].password), record(vectors.hashes[0].phc), {
    signal,
  });

it('refuses immediately when slots and queue are full', async () => {
  const gates: Gate[] = [];
  const hasher = seam(
    () => {
      const g = gate();
      gates.push(g);
      return g.promise;
    },
    { maxConcurrent: 1, maxQueued: 1, queueWaitMs: 1000 },
  );
  const a = verifyGood(hasher);
  await tick();
  const b = verifyGood(hasher);
  await tick();
  const c = await verifyGood(hasher);
  refusal(c, 'unavailable', 'identity.hash_saturated');
  expect(gates.length).toBe(1);
  gates[0].resolve(goodTag);
  expect(value(await a)).toBe('match');
  await tick();
  expect(gates.length).toBe(2);
  gates[1].resolve(goodTag);
  expect(value(await b)).toBe('match');
});

it('times out a queued caller and abandons it without consuming a slot', async () => {
  const gates: Gate[] = [];
  const hasher = seam(
    () => {
      const g = gate();
      gates.push(g);
      return g.promise;
    },
    { maxConcurrent: 1, maxQueued: 1, queueWaitMs: 20 },
  );
  const a = verifyGood(hasher);
  await tick();
  const b = await verifyGood(hasher);
  refusal(b, 'timeout', 'identity.hash_queue_timeout');
  const c = verifyGood(hasher);
  await tick();
  expect(gates.length).toBe(1);
  gates[0].resolve(goodTag);
  expect(value(await a)).toBe('match');
  await tick();
  gates[1].resolve(goodTag);
  expect(value(await c)).toBe('match');
});

it('maps an aborted signal while queued to canceled', async () => {
  const gates: Gate[] = [];
  const hasher = seam(
    () => {
      const g = gate();
      gates.push(g);
      return g.promise;
    },
    { maxConcurrent: 1, maxQueued: 1, queueWaitMs: 1000 },
  );
  const a = verifyGood(hasher);
  await tick();
  const control = new AbortController();
  const b = verifyGood(hasher, control.signal);
  await tick();
  control.abort();
  refusal(await b, 'canceled', 'identity.hash_canceled');
  const c = verifyGood(hasher);
  await tick();
  gates[0].resolve(goodTag);
  expect(value(await a)).toBe('match');
  await tick();
  expect(gates.length).toBe(2);
  gates[1].resolve(goodTag);
  expect(value(await c)).toBe('match');
  const already = new AbortController();
  already.abort();
  refusal(
    await verifyGood(hasher, already.signal),
    'canceled',
    'identity.hash_canceled',
  );
});

it('completes admitted work even when the deadline passes in flight', async () => {
  const g = gate();
  const hasher = seam(() => g.promise, {
    maxConcurrent: 1,
    maxQueued: 0,
    queueWaitMs: 1000,
  });
  const control = new AbortController();
  const a = verifyGood(hasher, control.signal);
  await tick();
  control.abort();
  await tick();
  g.resolve(goodTag);
  expect(value(await a)).toBe('match');
});

it('releases the slot after rejected work', async () => {
  let first = true;
  const hasher = seam(
    () => {
      if (first) {
        first = false;
        return Promise.reject(new Error('native failure'));
      }
      return Promise.resolve(goodTag);
    },
    { maxConcurrent: 1, maxQueued: 0, queueWaitMs: 1000 },
  );
  refusal(await verifyGood(hasher), 'internal', 'identity.hash_failed');
  expect(value(await verifyGood(hasher))).toBe('match');
});
