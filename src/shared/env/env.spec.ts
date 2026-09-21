import { expect, it } from 'vitest';
import { Reader, map } from './index.js';

it('distinguishes absent, empty, required and secret values', () => {
  const reader = new Reader(map({ EMPTY: '', SET: 'yes' }));
  expect(reader.string('ABSENT', 'default')).toBe('default');
  expect(reader.string('EMPTY', 'default')).toBe('');
  expect(reader.required('SET')).toBe('yes');
  expect(reader.check().ok).toBe(true);
  reader.secret('MISSING');
  expect(reader.check().ok).toBe(false);
});

it('parses strict integers, booleans and enumerations', () => {
  for (const value of [
    '',
    ' 2',
    '2 ',
    '+2',
    '02',
    '1e2',
    '1.5',
    '9007199254740992',
  ]) {
    const reader = new Reader(map({ N: value }));
    reader.int('N', 2, -9007199254740991, 9007199254740991);
    expect(reader.check().ok, value).toBe(false);
  }

  const reader = new Reader(map({ N: '-3', B: 'false', E: 'json' }));
  expect(reader.int('N', 2, -3, 3)).toBe(-3);
  expect(reader.boolean('B', true)).toBe(false);
  expect(reader.enumeration('E', 'console', ['console', 'json'])).toBe('json');
  expect(reader.check().ok).toBe(true);

  const invalid = new Reader(map({ B: 'TRUE', E: ' json' }));
  invalid.boolean('B', false);
  invalid.enumeration('E', 'console', ['console', 'json']);
  const result = invalid.check();
  expect(result.ok).toBe(false);
  if (!result.ok) expect(Object.keys(result.error.fields ?? {})).toHaveLength(2);
});

it('collects safe failures and sorted redacted manifests', () => {
  const input = { TOKEN: 'private-SENTINEL', NAME: 'visible' };
  const reader = new Reader(map(input));
  input.TOKEN = 'changed';
  expect(reader.secret('TOKEN').reveal()).toBe('private-SENTINEL');
  reader.required('NAME');
  reader.int('COUNT', 3, 0, 10);
  const manifest = reader.manifest();
  expect(manifest.ok).toBe(true);
  if (manifest.ok) {
    expect(manifest.value.map((value) => [value.key, value.value, value.source])).toEqual([
      ['COUNT', '3', 'default'],
      ['NAME', 'visible', 'environment'],
      ['TOKEN', '[REDACTED]', 'environment'],
    ]);
    manifest.value[2].value = 'oops';
    const again = reader.manifest();
    if (again.ok) expect(again.value[2].value).toBe('[REDACTED]');
  }
});

it('rejects duplicate and malformed definitions without echoing values', () => {
  const reader = new Reader(map({ N: 'private-SENTINEL', EMPTY: '' }));
  reader.int('N', 1, 0, 10);
  reader.required('EMPTY');
  const result = reader.check();
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(Object.keys(result.error.fields ?? {})).toHaveLength(2);
    expect(JSON.stringify(result.error)).not.toContain('private-SENTINEL');
  }

  const duplicate = new Reader(map({}));
  duplicate.string('A', 'a');
  duplicate.string('A', 'b');
  expect(duplicate.check().ok).toBe(false);
});
