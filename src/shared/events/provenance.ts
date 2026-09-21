import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';
import type { Envelope } from './index.js';
import type { WorkContext } from '../provenance/index.js';

function comparable(work: WorkContext): string {
  const snapshot = work.snapshot();
  return JSON.stringify({
    workId: snapshot.workId,
    correlationId: snapshot.correlationId,
    correlationSource: snapshot.correlationSource,
    operation: snapshot.operation,
    attribution: {
      initiator: snapshot.attribution.initiator ?? null,
      onBehalfOf: snapshot.attribution.onBehalfOf ?? null,
      tenant: snapshot.attribution.tenant ?? null,
    },
    causation: snapshot.causation ?? null,
    origin: snapshot.origin ?? null,
    depth: snapshot.depth ?? null,
    replay: snapshot.replay ?? null,
  });
}

/** A writer may persist only an event created for its current work scope. */
export function assertEventWork(
  event: Envelope,
  work: WorkContext,
): Result<void, Failure> {
  if (comparable(event.work) === comparable(work)) return ok(undefined);

  return err(
    failure('invalid', 'event provenance does not match the write', {
      type: 'events.provenance_mismatch',
    }),
  );
}
