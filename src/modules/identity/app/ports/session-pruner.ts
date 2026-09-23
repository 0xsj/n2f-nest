import type { Failure, Result } from '../../../../shared/errors/index.js';

/**
 * Deletes sessions that can never authenticate again: revoked or expired
 * before `endedBefore`, or last used before `idleBefore`. Returns how many
 * were deleted, at most `limit`.
 */
export interface SessionPruner {
  prune(
    input: Readonly<{ endedBefore: Date; idleBefore: Date; limit: number }>,
    signal?: AbortSignal,
  ): Promise<Result<number, Failure>>;
}
