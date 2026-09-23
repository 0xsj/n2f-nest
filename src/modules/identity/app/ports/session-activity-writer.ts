import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';

/**
 * Records that a session was used. Activity only moves forward and leaves the
 * session's version alone, so it never conflicts with a revocation.
 */
export interface SessionActivityWriter {
  record(sessionId: ID, at: Date, signal?: AbortSignal): Promise<Result<void, Failure>>;
}
