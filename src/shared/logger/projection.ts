import {
  causeOf,
  err,
  fromCaught,
  kindOf,
  ok,
  publicInfo,
  type Failure,
  type Result,
} from '../errors/index.js';
import { validScope, type Scope } from '../provenance/scope.js';
import { invalid } from './config.js';

export function errorProjection(
  error: unknown,
): Record<string, unknown> | undefined {
  if (error === undefined || error === null) return undefined;
  const kind = kindOf(error);
  const selected = kind === undefined ? undefined : fromCaught(error);
  return {
    classified: kind !== undefined,
    kind: kind ?? 'internal',
    ...(selected?.type ? { type: selected.type } : {}),
    public: publicInfo(error),
    has_cause: causeOf(error) !== undefined,
  };
}

export function scopeProjection(
  scope: Scope,
): Result<Record<string, unknown>, Failure> {
  if (!validScope(scope)) return err(invalid());
  const snapshot = scope.snapshot();
  const work = snapshot.work;
  return ok({
    scope_id: snapshot.scopeId,
    work_id: work.workId,
    correlation_id: work.correlationId,
    correlation_source: work.correlationSource,
    operation: work.operation,
    started_at_ms: snapshot.startedAt.getTime(),
    executor: snapshot.executor,
    attempt: snapshot.attempt,
    attribution: {
      ...(work.attribution.initiator
        ? { initiator: work.attribution.initiator }
        : {}),
      ...(work.attribution.onBehalfOf
        ? { on_behalf_of: work.attribution.onBehalfOf }
        : {}),
      ...(work.attribution.tenant
        ? { tenant: work.attribution.tenant }
        : {}),
    },
    ...(work.origin === undefined ? {} : { origin: work.origin }),
    ...(work.depth === undefined ? {} : { depth: work.depth }),
    ...(work.causation === undefined ? {} : { causation: work.causation }),
    ...(snapshot.previousAttempt === undefined
      ? {}
      : { previous_attempt: snapshot.previousAttempt }),
    ...(work.replay === undefined
      ? {}
      : {
          replay: {
            run_id: work.replay.runId,
            source: work.replay.source,
          },
        }),
  });
}
