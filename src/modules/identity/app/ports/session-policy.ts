import type { Failure, Result } from '../../../../shared/errors/index.js';

export interface SessionPolicy {
  /** Absolute expiry of a session created at `createdAt`. */
  expiresAt(createdAt: Date): Result<Date, Failure>;
  /** Inactivity after which a session no longer authenticates. */
  readonly idleTimeoutMs: number;
  /** A session's use is recorded at most this often, bounding writes per request. */
  readonly activityIntervalMs: number;
  /** Most active sessions per identity; a login beyond it revokes the oldest. */
  readonly maxActivePerIdentity: number;
}
