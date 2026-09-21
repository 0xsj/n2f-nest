import {
  actor,
  anonymous,
  attribution,
  operation,
  reference,
  restoreWork,
  type Actor,
  type ActorKind,
  type CorrelationSource,
  type Origin,
  type ReferenceKind,
  type WorkContext,
  type WorkSnapshot,
} from '../../../../shared/provenance/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';

const invalid = () =>
  failure('internal', 'stored audit provenance is invalid', {
    type: 'audit.persistence_invalid',
  });

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function storedId(value: unknown): Result<ID, Failure> {
  const candidate = text(value);
  return candidate === undefined ? err(invalid()) : parse(candidate);
}

function actorFrom(value: unknown): Result<Actor | undefined, Failure> {
  if (value === undefined || value === null) return ok(undefined);
  const input = object(value);
  if (!input) return err(invalid());
  const kind = text(input.kind);
  if (kind === 'anonymous') return ok(anonymous());
  const identity = text(input.identity);
  if (!kind || identity === undefined) return err(invalid());
  return actor(kind as ActorKind, identity);
}

function referenceFrom(value: unknown): Result<WorkSnapshot['causation'], Failure> {
  if (value === undefined || value === null) return ok(undefined);
  const input = object(value);
  if (!input) return err(invalid());
  const kind = text(input.kind);
  const id = storedId(input.id);
  if (!kind || !id.ok) return err(invalid());
  return reference(kind as ReferenceKind, id.value);
}

export function encodeWork(work: WorkSnapshot): Record<string, unknown> {
  return {
    work_id: work.workId,
    correlation_id: work.correlationId,
    correlation_source: work.correlationSource,
    operation: work.operation,
    attribution: {
      initiator: work.attribution.initiator,
      on_behalf_of: work.attribution.onBehalfOf,
      tenant: work.attribution.tenant,
    },
    causation: work.causation,
    origin: work.origin,
    depth: work.depth,
    replay: work.replay
      ? {
          run_id: work.replay.runId,
          source: work.replay.source,
        }
      : undefined,
  };
}

export function decodeWork(value: unknown): Result<WorkContext, Failure> {
  const input = object(value);
  const rawAttribution = input && object(input.attribution);
  if (!input || !rawAttribution) return err(invalid());

  const workId = storedId(input.work_id);
  const correlationId = storedId(input.correlation_id);
  const operationValue = text(input.operation);
  const source = text(input.correlation_source);
  const initiator = actorFrom(rawAttribution.initiator);
  const onBehalfOf = actorFrom(rawAttribution.on_behalf_of);
  const causation = referenceFrom(input.causation);
  if (
    !workId.ok ||
    !correlationId.ok ||
    !operationValue ||
    !source ||
    !initiator.ok ||
    !onBehalfOf.ok ||
    !causation.ok
  ) {
    return err(invalid());
  }

  const operationValueResult = operation(operationValue);
  const attributionValue = attribution({
    initiator: initiator.value,
    onBehalfOf: onBehalfOf.value,
    tenant:
      rawAttribution.tenant === undefined || rawAttribution.tenant === null
        ? undefined
        : text(rawAttribution.tenant),
  });
  if (!operationValueResult.ok || !attributionValue.ok) return err(invalid());

  let replay: WorkSnapshot['replay'];
  if (input.replay !== undefined && input.replay !== null) {
    const rawReplay = object(input.replay);
    const runId = rawReplay && storedId(rawReplay.run_id);
    const sourceReference = rawReplay && referenceFrom(rawReplay.source);
    if (!rawReplay || !runId?.ok || !sourceReference?.ok || !sourceReference.value) {
      return err(invalid());
    }
    replay = { runId: runId.value, source: sourceReference.value };
  }

  return restoreWork({
    workId: workId.value,
    correlationId: correlationId.value,
    correlationSource: source as CorrelationSource,
    operation: operationValueResult.value,
    attribution: attributionValue.value,
    causation: causation.value,
    origin: input.origin === undefined ? undefined : (input.origin as Origin),
    depth: input.depth as number | undefined,
    replay,
  });
}
