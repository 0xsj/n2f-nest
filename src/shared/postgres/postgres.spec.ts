import pg from 'pg';
import { expect, it } from 'vitest';
import { SecretString } from '../secret/index.js';
import { Database, map, violatedUnique } from './index.js';

function databaseError(code: string, constraint?: string): pg.DatabaseError {
  const error = new pg.DatabaseError('driver detail', 0, 'error');
  error.code = code;
  error.constraint = constraint;
  return error;
}

it('validates database configuration before opening a pool', async () => {
  for (const config of [
    { url: 'http://localhost', maxConnections: 4, timeoutMs: 1000 },
    { url: 'postgres://', maxConnections: 4, timeoutMs: 1000 },
    { url: 'postgres://localhost', maxConnections: 0, timeoutMs: 1000 },
    { url: 'postgres://localhost', maxConnections: 4, timeoutMs: 0 },
  ]) {
    const result = await Database.open({
      ...config,
      url: new SecretString(config.url),
    });
    expect(result.ok).toBe(false);
  }
});

it('maps known PostgreSQL classes without exposing driver details', () => {
  expect(map(new Error('network')).type).toBe('database.unavailable');
  expect(map({ kind: 'conflict', message: 'already exists' }).type).toBe(
    'database.unavailable',
  );
});

it('separates unique violations from retryable serialization failures', () => {
  expect(map(databaseError('23505', 'n2f_example_key'))).toMatchObject({
    kind: 'conflict',
    type: 'database.conflict',
  });
  for (const code of ['40001', '40P01']) {
    expect(map(databaseError(code))).toMatchObject({
      kind: 'unavailable',
      type: 'database.serialization',
    });
  }
  expect(map(databaseError('23505')).message).not.toContain('driver detail');
});

it('names the violated unique constraint only for unique violations', () => {
  expect(violatedUnique(databaseError('23505', 'n2f_example_key'))).toBe(
    'n2f_example_key',
  );
  expect(violatedUnique(databaseError('23503', 'n2f_example_fkey'))).toBeUndefined();
  expect(violatedUnique(new Error('network'))).toBeUndefined();
});
