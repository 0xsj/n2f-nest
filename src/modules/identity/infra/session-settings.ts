import { Reader, os, type Lookup } from '../../../shared/env/index.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type SessionSettings = Readonly<{
  lifetimeMs: number;
  idleTimeoutMs: number;
  maxActivePerIdentity: number;
  retentionMs: number;
}>;

export const SESSION_SETTINGS = Symbol('identity.sessionSettings');

/**
 * Session limits, from the environment:
 *
 * - `N2F_SESSION_LIFETIME_HOURS` (default 24): absolute lifetime.
 * - `N2F_SESSION_IDLE_MINUTES` (default 60): inactivity that ends a session.
 * - `N2F_SESSION_MAX_PER_IDENTITY` (default 10): a login beyond it revokes
 *   the identity's oldest session.
 * - `N2F_SESSION_RETENTION_DAYS` (default 7): how long ended sessions are
 *   kept before they are pruned.
 *
 * Invalid values stop startup rather than weaken a limit.
 */
export function sessionSettings(source?: Lookup): SessionSettings {
  const resolved = source === undefined ? os() : { ok: true as const, value: source };
  if (!resolved.ok) throw new Error(resolved.error.message);
  const reader = new Reader(resolved.value);
  const lifetimeHours = reader.int('N2F_SESSION_LIFETIME_HOURS', 24, 1, 720);
  const idleMinutes = reader.int('N2F_SESSION_IDLE_MINUTES', 60, 1, 43_200);
  const maxActivePerIdentity = reader.int('N2F_SESSION_MAX_PER_IDENTITY', 10, 1, 1000);
  const retentionDays = reader.int('N2F_SESSION_RETENTION_DAYS', 7, 0, 365);
  const valid = reader.check();
  if (!valid.ok) {
    throw new Error(`invalid configuration: ${Object.keys(valid.error.fields ?? {}).join(', ')}`);
  }
  return Object.freeze({
    lifetimeMs: lifetimeHours * HOUR,
    idleTimeoutMs: idleMinutes * MINUTE,
    maxActivePerIdentity,
    retentionMs: retentionDays * DAY,
  });
}
