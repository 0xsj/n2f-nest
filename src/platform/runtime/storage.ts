import type { Database } from '../../shared/postgres/index.js';
import type { RuntimeConfig } from './config.js';

/** Runtime storage selection is shared composition policy, not domain policy. */
export function usesPostgres(config: RuntimeConfig): boolean {
  return config.storage === 'postgres';
}

/** Provider factories fail at composition when the selected capability is absent. */
export function requireDatabase(
  database: Database | undefined,
  moduleName: string,
): Database {
  if (!database) {
    throw new Error(`PostgreSQL ${moduleName} storage was not initialized`);
  }
  return database;
}
