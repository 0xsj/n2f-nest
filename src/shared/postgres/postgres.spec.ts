import { expect, it } from 'vitest';
import { SecretString } from '../secret/index.js';
import { Database, map } from './index.js';

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
