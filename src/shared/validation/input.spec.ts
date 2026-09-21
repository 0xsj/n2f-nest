import { describe, expect, it } from 'vitest';
import * as pagination from '../pagination/index.js';
import * as validation from './index.js';

describe('validation and pagination', () => {
  it('checks text and strict decimal input', () => {
    for (const value of [
      '',
      '00',
      '01',
      '+1',
      '-1',
      '1.0',
      ' 1',
      '1 ',
      '1\n',
      '١',
      '2147483648',
      '12345678901',
    ]) {
      expect(validation.decimal(value, 0, 2147483647).ok, value).toBe(false);
    }
    for (const value of ['0', '1', '2147483647']) {
      expect(validation.decimal(value, 0, 2147483647).ok).toBe(true);
    }
    for (const [value, length] of [
      ['😀', 1],
      ['é', 2],
      ['\u00a0', 1],
    ] as const) {
      expect(validation.text(value, length, length, true).ok).toBe(true);
    }
    for (const value of ['', ' \t\n', '\ud800']) {
      expect(validation.text(value, 0, 10, true).ok).toBe(false);
    }
    expect(validation.text('a', 2, 1, false).ok).toBe(false);
  });

  it('bounds and owns validation reports', () => {
    const report = new validation.Report();
    expect(report.result().ok).toBe(true);
    for (let i = 0; i < 32; i += 1) {
      expect(report.add(`f${i}`, 'required').ok).toBe(true);
    }
    expect(report.add('f0', 'other').ok).toBe(true);
    expect(report.truncated).toBe(false);
    const snapshot = report.issues();
    snapshot[0] = { field: 'f0', code: 'mutated' };
    expect(report.add('overflow', 'invalid').ok).toBe(true);
    expect(report.truncated).toBe(true);
    expect(report.issues()).toHaveLength(32);
    expect(report.issues()[0].code).toBe('required');
    expect(report.result().ok).toBe(false);
    expect(report.add('password', 'secret value').ok).toBe(false);
    expect(report.add('bad/name', 'required').ok).toBe(false);
  });

  it('bounds and scopes opaque pagination cursors', () => {
    expect(pagination.size()).toEqual({ ok: true, value: 25 });
    for (const value of ['', '0', '101', '01', '1.1', '1\n']) {
      expect(pagination.size(value).ok).toBe(false);
    }

    const encoded = pagination.encode('org:1/name', '😀/42');
    if (!encoded.ok) throw new Error('fixture');
    expect(pagination.decode(encoded.value, 'org:1/name')).toEqual({
      ok: true,
      value: '😀/42',
    });
    expect(pagination.decode(encoded.value, 'org:2/name').ok).toBe(false);

    for (const raw of [
      '[2,"s","p"]',
      '[1,"s",null]',
      '[1,"s","\\ud800"]',
      '[1,"s","\\udc00"]',
      '[1,"s","\\n"]',
      '[1,"s",""]',
      '[1,"s","p",0]',
      '[1,"s","p"] {}',
    ]) {
      expect(
        pagination.decode(Buffer.from(raw).toString('base64url'), 's').ok,
        raw,
      ).toBe(false);
    }
    for (const raw of [
      '[1.0,"s","p"]',
      '[1,"s","😀"]',
      '[1,"s","\\\\ud800"]',
    ]) {
      expect(
        pagination.decode(Buffer.from(raw).toString('base64url'), 's').ok,
        raw,
      ).toBe(true);
    }
  });

  it('anchors a page cursor on the last returned row and owns the window', () => {
    const rows = ['a', 'b', 'c'];
    const page = pagination.window(rows, 2, 's', (row) => row);
    if (!page.ok) throw new Error('fixture');
    expect(page.value.items).toEqual(['a', 'b']);
    expect(page.value.hasMore).toBe(true);
    expect(pagination.decode(page.value.nextCursor!, 's')).toEqual({
      ok: true,
      value: 'b',
    });
    page.value.items[0] = 'mutated';
    expect(rows[0]).toBe('a');
    expect(pagination.window([], 2, 's', String)).toEqual({
      ok: true,
      value: { items: [], hasMore: false },
    });
    expect(pagination.window(rows, 1, 's', (row) => row).ok).toBe(false);
  });
});
