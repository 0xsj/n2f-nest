import { describe, expect, it } from 'vitest';
import { map } from '../../shared/env/index.js';
import { parseRuntimeConfig } from './config.js';
import { requireDatabase, usesPostgres } from './storage.js';

describe('runtime storage composition', () => {
  it('exposes one domain-neutral storage decision to every module', () => {
    const memory = parseRuntimeConfig(map({}));
    const postgres = parseRuntimeConfig(
      map({
        N2F_STORAGE: 'postgres',
        N2F_DATABASE_URL: 'postgres://localhost/n2f',
        N2F_EVENT_TRANSPORT: 'local',
      }),
    );

    expect(memory.ok && usesPostgres(memory.value)).toBe(false);
    expect(postgres.ok && usesPostgres(postgres.value)).toBe(true);
  });

  it('fails composition when PostgreSQL was selected without a database', () => {
    expect(() => requireDatabase(undefined, 'Document')).toThrow(
      'PostgreSQL Document storage was not initialized',
    );
  });
});
