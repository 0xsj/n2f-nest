import { describe, expect, it } from 'vitest';
import {
  after,
  compareKeyset,
  decode,
  encode,
  keysetPage,
  position,
  request,
  size,
  window,
} from './index.js';

const invalid = { ok: false, error: { kind: 'invalid', type: 'pagination.invalid' } };
const wire = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('size', () => {
  it('accepts 1 to 100 and defaults to 25', () => {
    expect(size()).toEqual({ ok: true, value: 25 });
    expect(size('1')).toEqual({ ok: true, value: 1 });
    expect(size('100')).toEqual({ ok: true, value: 100 });
  });
});

describe('encode', () => {
  it('wraps a versioned (scope, position) pair', () => {
    const encoded = encode('s', 'p');
    expect(encoded).toEqual({ ok: true, value: wire([1, 's', 'p']) });
  });

  it('bounds scope and position by UTF-8 bytes', () => {
    expect(encode('a'.repeat(128), 'p').ok).toBe(true);
    expect(encode('a'.repeat(129), 'p')).toMatchObject(invalid);
    expect(encode('é'.repeat(64), 'p').ok).toBe(true);
    expect(encode('é'.repeat(65), 'p')).toMatchObject(invalid);
    expect(encode('s', 'a'.repeat(256)).ok).toBe(true);
    expect(encode('s', 'a'.repeat(257))).toMatchObject(invalid);
  });

  it('refuses empty, control-character and lone-surrogate parts', () => {
    expect(encode('s', ' ~').ok).toBe(true);
    for (const bad of ['', '\u0000', 'a\u001fb', '\u007f', '\ud800', 'a\udc00']) {
      expect(encode(bad, 'p'), JSON.stringify(bad)).toMatchObject(invalid);
      expect(encode('s', bad), JSON.stringify(bad)).toMatchObject(invalid);
    }
    expect(encode(1 as never, 'p')).toMatchObject(invalid);
    expect(encode(['s'] as never, 'p')).toMatchObject(invalid);
    expect(encode('s', ['p'] as never)).toMatchObject(invalid);
  });
});

describe('decode', () => {
  it('refuses wires that are empty, oversized, or not canonical base64url', () => {
    const good = wire([1, 's', 'p']);
    expect(decode(good, 's')).toEqual({ ok: true, value: 'p' });
    for (const bad of [
      '',
      'A'.repeat(1025),
      `${good}=`,
      `+${good}`,
      `/${good}`,
      `${good} `,
      Buffer.from(JSON.stringify([1, 's', 'p'])).toString('base64'),
    ]) {
      if (bad === good) continue;
      expect(decode(bad, 's'), bad).toMatchObject(invalid);
    }
    // Same bytes with non-zero padding bits: decodable, but not canonical.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    expect(good.length % 4).not.toBe(0);
    const last = alphabet[alphabet.indexOf(good.at(-1)!) ^ 1];
    const aliased = good.slice(0, -1) + last;
    expect(Buffer.from(aliased, 'base64url')).toEqual(Buffer.from(good, 'base64url'));
    expect(decode(aliased, 's')).toMatchObject(invalid);
  });

  it('refuses a wire longer than the longest cursor encode can issue', () => {
    const scope = '"'.repeat(128);
    const longest = encode(scope, '"'.repeat(256));
    if (!longest.ok) throw new Error('fixture');
    expect(longest.value).toHaveLength(1036);
    expect(decode('A'.repeat(1037), scope)).toMatchObject(invalid);
  });

  // Found by mutation testing: JSON escaping once pushed a maximal cursor past
  // decode's fixed 1024-character bound, so encode issued unreadable cursors.
  it('decodes every cursor that encode issues, including maximally escaped ones', () => {
    for (const [scope, position] of [
      ['"'.repeat(128), '"'.repeat(256)],
      ['\\'.repeat(128), '\\'.repeat(256)],
      ['é'.repeat(64), '😀'.repeat(64)],
    ] as const) {
      const encoded = encode(scope, position);
      if (!encoded.ok) throw new Error('fixture');
      expect(decode(encoded.value, scope)).toEqual({ ok: true, value: position });
    }
  });

  it('refuses an invalid scope even for a matching cursor', () => {
    expect(decode(wire([1, '', 'p']), '')).toMatchObject(invalid);
    expect(decode(wire([1, 'a'.repeat(129), 'p']), 'a'.repeat(129))).toMatchObject(invalid);
  });

  it('refuses bytes that are not UTF-8 or not JSON', () => {
    const malformed = Buffer.concat([
      Buffer.from('[1,"s","p'),
      Buffer.from([0xff]),
      Buffer.from('"]'),
    ]);
    expect(decode(malformed.toString('base64url'), 's')).toMatchObject(invalid);
    expect(decode(Buffer.from('not json').toString('base64url'), 's')).toMatchObject(invalid);
    expect(decode(wire({ 0: 1, 1: 's', 2: 'p', length: 3 }), 's')).toMatchObject(invalid);
    expect(decode(wire([1, 's']), 's')).toMatchObject(invalid);
  });
});

describe('window', () => {
  const rows = ['a', 'b', 'c'];

  it('refuses limits outside 1 to 100 or more rows than limit + 1', () => {
    for (const limit of [0, 101, 1.5, Number.NaN]) {
      expect(window([], limit, 's', String), String(limit)).toMatchObject(invalid);
    }
    expect(window([], 1, 's', String).ok).toBe(true);
    expect(window([], 100, 's', String).ok).toBe(true);
    expect(window(rows, 1, 's', String)).toMatchObject(invalid);
  });

  it('reports no more rows when the lookahead row is absent', () => {
    const page = window(rows, 3, 's', String);
    expect(page).toEqual({ ok: true, value: { items: rows, hasMore: false } });
    if (page.ok) expect(page.value.items).not.toBe(rows);
  });

  it('fails when the last row has no encodable position', () => {
    expect(window(rows, 2, 's', () => '')).toMatchObject(invalid);
  });
});

describe('keyset positions', () => {
  const at = new Date('2026-09-19T00:00:00.000Z');

  it('round-trips a (time, id) position', () => {
    expect(position(at, 'x')).toBe('2026-09-19T00:00:00.000Z|x');
    expect(after(position(at, 'x'))).toEqual({ at, id: 'x' });
  });

  it('rejects malformed positions', () => {
    for (const value of [
      '',
      'x',
      '2026-09-19T00:00:00.000Z',
      '2026-09-19T00:00:00.000Z|',
      '|x',
      '2026-09-19T00:00:00.000Z|x|y',
      '2026-09-19T00:00:00Z|x',
      'not-a-date|x',
    ]) {
      expect(after(value), value).toBeUndefined();
    }
  });

  it('orders by time, then ordinal id', () => {
    const later = new Date(at.getTime() + 1);
    expect(compareKeyset({ at, id: 'b' }, { at: later, id: 'a' })).toBeLessThan(0);
    expect(compareKeyset({ at: later, id: 'a' }, { at, id: 'b' })).toBeGreaterThan(0);
    expect(compareKeyset({ at, id: 'a' }, { at, id: 'b' })).toBe(-1);
    expect(compareKeyset({ at, id: 'b' }, { at, id: 'a' })).toBe(1);
    expect(compareKeyset({ at, id: 'a' }, { at, id: 'a' })).toBe(0);
    expect(compareKeyset({ at, id: 'B' }, { at, id: 'a' })).toBe(-1);
  });

  it('pages strictly after a keyset position, one row past the limit', () => {
    const row = (minutes: number, id: string) => ({
      at: new Date(at.getTime() + minutes * 60_000),
      id,
    });
    const rows = [row(2, 'a'), row(1, 'b'), row(1, 'a'), row(3, 'a'), row(4, 'a')];
    const snapshot = [...rows];

    expect(keysetPage(rows, (r) => r, { limit: 2 })).toEqual([row(1, 'a'), row(1, 'b'), row(2, 'a')]);
    expect(keysetPage(rows, (r) => r, { limit: 2, after: row(1, 'a') })).toEqual([
      row(1, 'b'),
      row(2, 'a'),
      row(3, 'a'),
    ]);
    expect(keysetPage(rows, (r) => r, { limit: 10, after: row(4, 'a') })).toEqual([]);
    expect(rows).toEqual(snapshot);
  });
});

describe('request', () => {
  const at = new Date('2026-09-19T00:00:00.000Z');

  it('defaults the limit and reads a scoped cursor', () => {
    expect(request('s')).toEqual({ ok: true, value: { limit: 25 } });
    expect(request('s', '10')).toEqual({ ok: true, value: { limit: 10 } });

    const cursor = encode('s', position(at, 'x'));
    if (!cursor.ok) throw new Error('fixture');
    expect(request('s', '10', cursor.value)).toEqual({
      ok: true,
      value: { limit: 10, after: { at, id: 'x' } },
    });
    expect(request('other', '10', cursor.value)).toMatchObject(invalid);
  });

  it('refuses bad limits and cursors without a keyset position', () => {
    expect(request('s', '0')).toMatchObject(invalid);
    expect(request('s', 'abc')).toMatchObject(invalid);
    expect(request('s', undefined, '!!')).toMatchObject(invalid);
    const cursor = encode('s', 'not-a-position');
    if (!cursor.ok) throw new Error('fixture');
    expect(request('s', undefined, cursor.value)).toMatchObject(invalid);
  });
});
