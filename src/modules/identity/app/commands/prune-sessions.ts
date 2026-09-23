import { err, failure, ok, type Result } from '../../../../shared/errors/index.js';
import type { WallClock } from '../../../../shared/clock/index.js';
import type { SessionPolicy, SessionPruner } from '../ports/index.js';
import { dependencyFailure, type IdentityApplicationFailure } from '../failures.js';

export type PruneSessionsCommand = Readonly<{
  /** How long an ended session is kept before deletion, for investigation. */
  retentionMs: number;
  limit: number;
  signal?: AbortSignal;
}>;

export type PruneSessionsDependencies = Readonly<{
  clock: WallClock;
  policy: Pick<SessionPolicy, 'idleTimeoutMs'>;
  pruner: SessionPruner;
}>;

/**
 * Deletes sessions that ended (revoked, expired or idle) more than
 * `retentionMs` ago. Ending a session already emitted its events, or needs
 * none because time ended it, so deletion records nothing.
 */
export class PruneSessions {
  constructor(private readonly dependencies: PruneSessionsDependencies) {}

  async execute(
    command: PruneSessionsCommand,
  ): Promise<Result<Readonly<{ pruned: number }>, IdentityApplicationFailure>> {
    if (
      !Number.isSafeInteger(command.retentionMs) ||
      command.retentionMs < 0 ||
      !Number.isSafeInteger(command.limit) ||
      command.limit < 1
    ) {
      return err(
        dependencyFailure(
          failure('invalid', 'session pruning bounds are invalid', {
            type: 'identity.invalid_prune_bounds',
          }),
          'session_pruner',
        ),
      );
    }
    const endedBefore = this.dependencies.clock.now().getTime() - command.retentionMs;
    const pruned = await this.dependencies.pruner.prune(
      {
        endedBefore: new Date(endedBefore),
        idleBefore: new Date(endedBefore - this.dependencies.policy.idleTimeoutMs),
        limit: command.limit,
      },
      command.signal,
    );
    if (!pruned.ok) {
      return err(dependencyFailure(pruned.error, 'session_pruner'));
    }
    return ok({ pruned: pruned.value });
  }
}
