import { describe, expect, it } from 'vitest';
import { FakeClock } from '../clock/index.js';
import {
  causeOf,
  publicInfo,
  type Failure,
  type Result,
} from '../errors/index.js';
import { parse, version, unixMillis, V7, Sequence, type ID } from './index.js';

const tick = 0x0123456789ab;
const first = '01234567-89ab-7000-8000-000000000000';

function unwrap<T>(result: Result<T, Failure>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function expectFailure<T>(
  result: Result<T, Failure>,
  kind: Failure['kind'],
  type: string,
): Failure {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected refusal');
  expect(result.error.kind).toBe(kind);
  expect(result.error.type).toBe(type);
  return result.error;
}

const zeros = (bytes: Uint8Array): void => {
  bytes.fill(0);
};

describe('id', () => {
  it('parses canonical UUID values and rejects unknown representations', () => {
    for (const input of [
      'F81D4FAE-7DEC-41D0-A765-00A0C91E6BF6',
      '01234567-89ab-f000-8000-000000000000',
      '01234567-89ab-0000-8000-000000000000',
    ]) {
      expect(unwrap(parse(input))).toBe(input.toLowerCase());
    }

    for (const input of [
      undefined,
      null,
      5,
      {},
      '',
      first + ' ',
      ' ' + first,
      first.replaceAll('-', ''),
      '{' + first + '}',
      'urn:uuid:' + first,
      '01234567_89ab-7000-8000-000000000000',
      '01234567-89ab-7000-8000-00000000000g',
      '00000000-0000-0000-0000-000000000000',
      '01234567-89ab-7000-0000-000000000000',
      '01234567-89ab-7000-c000-000000000000',
      '01234567-89ab-7000-f000-000000000000',
      first + '\n',
    ]) {
      expectFailure(parse(input), 'invalid', 'id.invalid');
    }
  });

  it('has value equality and reads UUID version and v7 time', () => {
    const value = unwrap(parse('017F22E2-79B0-7CC3-98C4-DC0C0C07398F'));
    const map = new Map<ID, string>([[value, 'found']]);

    expect(map.get(unwrap(parse(value)))).toBe('found');
    expect(version(value)).toBe(7);
    expect(unixMillis(value)).toBe(1645557742000);
    expect(
      unixMillis(unwrap(parse('f81d4fae-7dec-41d0-a765-00a0c91e6bf6'))),
    ).toBeUndefined();
    expect(JSON.stringify({ id: value })).toBe(
      '{"id":"017f22e2-79b0-7cc3-98c4-dc0c0c07398f"}',
    );
  });

  it('encodes exact UUIDv7 bytes and standard variant bits', () => {
    const clock = new FakeClock(new Date(tick));
    const generator = new V7(clock, (bytes) => {
      expect(bytes.length).toBe(10);
      bytes.set([7, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
    });

    expect(unwrap(generator.newId())).toBe(
      '01234567-89ab-77ff-bfff-ffffffffffff',
    );
    expect(unwrap(new V7(clock, zeros).newId())).toBe(first);
  });

  it('keeps one generator strictly ordered across rollback', () => {
    const clock = new FakeClock(new Date(tick));
    let calls = 0;
    const generator = new V7(clock, (bytes) => {
      bytes.fill(++calls === 1 ? 255 : 0);
    });

    const a = unwrap(generator.newId());
    const b = unwrap(generator.newId());
    clock.set(new Date(tick - 100));
    const d = unwrap(generator.newId());

    expect(a < b && b < d).toBe(true);
    expect(b).toBe('01234567-89ab-7800-8000-000000000000');
    expect(unixMillis(d)).toBe(tick);

    clock.set(new Date(tick + 1));
    const e = unwrap(generator.newId());
    expect(e > d).toBe(true);
    expect(e).toBe('01234567-89ac-7000-8000-000000000000');
  });

  it('refuses counter exhaustion and recovers after a later wall millisecond', () => {
    const clock = new FakeClock(new Date(tick));
    let calls = 0;
    const generator = new V7(clock, (bytes) => {
      calls += 1;
      zeros(bytes);
    });
    let last = '';

    for (let i = 0; i < 4096; i += 1) {
      const value = unwrap(generator.newId());
      expect(value > last).toBe(true);
      last = value;
    }

    for (let i = 0; i < 2; i += 1) {
      expectFailure(generator.newId(), 'unavailable', 'id.exhausted');
    }
    expect(calls).toBe(4096);

    clock.set(new Date(tick - 1));
    expectFailure(generator.newId(), 'unavailable', 'id.exhausted');
    clock.set(new Date(tick + 1));
    expect(unwrap(generator.newId()) > last).toBe(true);
  });

  it('keeps entropy failures atomic and preserves their private cause', () => {
    const clock = new FakeClock(new Date(tick));
    const sentinel = new Error('private entropy diagnostic');
    let fail = true;
    const generator = new V7(clock, (bytes) => {
      if (fail) throw sentinel;
      zeros(bytes);
    });

    const firstFailure = expectFailure(
      generator.newId(),
      'unavailable',
      'id.entropy',
    );
    expect(causeOf(firstFailure)).toBe(sentinel);
    expect(publicInfo(firstFailure).message).not.toContain('private');

    fail = false;
    expect(unwrap(generator.newId())).toBe(first);
    clock.set(new Date(tick + 100));
    fail = true;
    expectFailure(generator.newId(), 'unavailable', 'id.entropy');
    fail = false;
    clock.set(new Date(tick));
    expect(unwrap(generator.newId())).toBe(
      '01234567-89ab-7001-8000-000000000000',
    );

    for (const cause of [undefined, null, 'offline']) {
      const generatorWithFailure = new V7(clock, () => {
        throw cause;
      });
      expect(
        causeOf(
          expectFailure(
            generatorWithFailure.newId(),
            'unavailable',
            'id.entropy',
          ),
        ),
      ).toBe(cause);
    }
  });

  it('refuses timestamps outside the UUIDv7 48-bit range before entropy', () => {
    let wall = new Date(0);
    let calls = 0;
    const generator = new V7(
      { now: () => wall },
      (bytes) => {
        calls += 1;
        zeros(bytes);
      },
    );

    expect(unwrap(generator.newId())).toBe(
      '00000000-0000-7000-8000-000000000000',
    );
    for (const timestamp of [-1, 2 ** 48, NaN]) {
      wall = new Date(timestamp);
      expectFailure(generator.newId(), 'invalid', 'id.time_range');
    }
    expect(calls).toBe(1);

    wall = new Date(2 ** 48 - 1);
    expect(unixMillis(unwrap(generator.newId()))).toBe(2 ** 48 - 1);
  });

  it('returns finite sequences in order and owns their input list', () => {
    const a = unwrap(parse(first));
    const b = unwrap(parse('01234567-89ab-7001-8000-000000000000'));
    const items = [a, b];
    const sequence = new Sequence(items);

    items[0] = b;
    expect(unwrap(sequence.newId())).toBe(a);
    expect(unwrap(sequence.newId())).toBe(b);
    for (let i = 0; i < 2; i += 1) {
      expectFailure(sequence.newId(), 'unavailable', 'id.sequence_exhausted');
    }
    expectFailure(
      new Sequence([]).newId(),
      'unavailable',
      'id.sequence_exhausted',
    );
  });

  it('uses system entropy and produces sequentially unique values in one generator', () => {
    const clock = new FakeClock(new Date(tick));
    expect(version(unwrap(new V7(clock).newId()))).toBe(7);

    const generator = new V7(clock, zeros);
    const seen = new Set<ID>();
    for (let i = 0; i < 1000; i += 1) {
      const value = unwrap(generator.newId());
      expect(seen.has(value)).toBe(false);
      seen.add(value);
    }
    expect(seen.size).toBe(1000);
  });
});
