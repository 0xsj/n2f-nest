import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';
import type { WallClock } from '../clock/index.js';
import type { ID, IDGenerator } from '../id/index.js';
import {
  invalid,
  namedActor,
  type Actor,
} from './actor.js';
import type { Attribution } from './attribution.js';
import type { Operation } from './operation.js';
import {
  reference,
  validID,
  validReference,
  type Reference,
} from './reference.js';
import {
  type DraftWork,
  type Origin,
  type WorkSnapshot,
  WorkContext,
  validOrigin,
  validWork,
  restoreWork,
  validateWork,
} from './work.js';
import {
  normalizedTime,
  Scope,
  validScope,
  restoreScope,
} from './scope.js';
import {
  IncomingResult,
  validIncoming,
} from './incoming.js';

export interface RootSpec {
  workId?: ID;
  origin: Origin;
  operation: Operation;
  attribution: Attribution;
  executor: Actor;
}

export interface StepSpec {
  workId?: ID;
  operation: Operation;
  executor: Actor;
  cause?: Reference;
}

export interface WorkSpec {
  workId: ID;
  operation: Operation;
  cause?: Reference;
}

export interface ExecutionSpec {
  executor: Actor;
  attempt: number;
}

export interface ReplaySpec {
  source: Reference;
  runId?: ID;
  workId?: ID;
  operation: Operation;
  attribution: Attribution;
  executor: Actor;
}

const generatedError = () =>
  failure('internal', 'invalid generated provenance ID', {
    type: 'provenance.invalid_generated_id',
  });

function rootWork(spec: RootSpec): Result<DraftWork, Failure> {
  if (!validOrigin(spec.origin) || spec.origin === 'replay') {
    return err(invalid('invalid_origin'));
  }
  if (spec.workId !== undefined && !validID(spec.workId)) {
    return err(invalid('invalid_work'));
  }

  return ok({
    workId: spec.workId,
    correlationSource: 'local',
    origin: spec.origin,
    operation: spec.operation,
    attribution: spec.attribution,
    depth: 0,
  });
}

function childWork(
  parent: Scope,
  workId: ID | undefined,
  operation: Operation,
  cause: Reference | undefined,
): Result<DraftWork, Failure> {
  if (!validScope(parent)) return err(invalid('invalid_scope'));
  const parentSnapshot = parent.snapshot();

  if (
    workId !== undefined &&
    (!validID(workId) || workId === parentSnapshot.work.workId)
  ) {
    return err(invalid('invalid_work'));
  }

  const work: DraftWork = {
    ...parentSnapshot.work,
    workId,
    operation,
  };

  if (work.depth !== undefined) {
    if (work.depth === 4294967295) {
      return err(invalid('depth_exhausted'));
    }
    work.depth += 1;
  }

  if (cause === undefined) {
    const created = reference('scope', parentSnapshot.scopeId);
    if (!created.ok) return created;
    work.causation = created.value;
  } else {
    work.causation = cause;
  }

  const error = validateWork(work, true);
  return error ? err(error) : ok(work);
}

export function prepare(
  parent: Scope,
  spec: WorkSpec,
): Result<WorkContext, Failure> {
  if (!validScope(parent)) return err(invalid('invalid_scope'));
  if (!validID(spec.workId)) return err(invalid('invalid_work'));

  const work = childWork(parent, spec.workId, spec.operation, spec.cause);
  return work.ok ? restoreWork(work.value as WorkSnapshot) : work;
}

export class Factory {
  constructor(
    private readonly clock: WallClock,
    private readonly ids: IDGenerator,
  ) {}

  #emit(
    work: DraftWork,
    executor: Actor,
    attempt: number,
    previousAttempt?: ID,
    forbidden: readonly ID[] = [],
  ): Result<Scope, Failure> {
    if (!namedActor(executor)) return err(invalid('invalid_actor'));
    if (
      !Number.isInteger(attempt) ||
      attempt < 1 ||
      attempt > 4294967295
    ) {
      return err(invalid('invalid_attempt'));
    }

    const error = validateWork(work, true);
    if (error) return err(error);

    const milliseconds = normalizedTime(this.clock.now());
    if (milliseconds === undefined) return err(invalid('invalid_time'));

    const next = this.ids.newId();
    if (!next.ok) return next;
    const scopeId = next.value;
    if (!validID(scopeId) || forbidden.includes(scopeId)) {
      return err(generatedError());
    }

    const snapshot: WorkSnapshot = {
      ...work,
      workId: work.workId ?? scopeId,
      correlationId: work.correlationId ?? scopeId,
      replay:
        work.replay === undefined
          ? undefined
          : { ...work.replay, runId: work.replay.runId ?? scopeId },
    };

    const restored = restoreScope({
      work: snapshot,
      scopeId,
      startedAt: new Date(milliseconds),
      executor,
      attempt,
      previousAttempt,
    });
    return restored.ok ? restored : err(generatedError());
  }

  open(spec: RootSpec): Result<Scope, Failure> {
    const work = rootWork(spec);
    return work.ok ? this.#emit(work.value, spec.executor, 1) : work;
  }

  child(parent: Scope, spec: StepSpec): Result<Scope, Failure> {
    const work = childWork(parent, spec.workId, spec.operation, spec.cause);
    if (!work.ok) return work;

    const parentSnapshot = parent.snapshot();
    const forbidden = [parentSnapshot.scopeId];
    if (spec.workId === undefined) {
      forbidden.push(parentSnapshot.work.workId);
    }
    return this.#emit(work.value, spec.executor, 1, undefined, forbidden);
  }

  execute(
    work: WorkContext,
    spec: ExecutionSpec,
  ): Result<Scope, Failure> {
    return validWork(work)
      ? this.#emit(work.snapshot(), spec.executor, spec.attempt)
      : err(invalid('invalid_work'));
  }

  retry(previous: Scope, executor: Actor): Result<Scope, Failure> {
    if (!validScope(previous)) return err(invalid('invalid_scope'));
    const snapshot = previous.snapshot();
    if (snapshot.attempt === 4294967295) {
      return err(invalid('attempt_exhausted'));
    }
    return this.#emit(
      snapshot.work,
      executor,
      snapshot.attempt + 1,
      snapshot.scopeId,
      [snapshot.scopeId],
    );
  }

  replay(spec: ReplaySpec): Result<Scope, Failure> {
    if (
      !validReference(spec.source) ||
      (spec.runId !== undefined && !validID(spec.runId))
    ) {
      return err(invalid('invalid_reference'));
    }
    if (
      spec.workId !== undefined &&
      (!validID(spec.workId) ||
        (spec.source.kind === 'work' && spec.source.id === spec.workId))
    ) {
      return err(invalid('invalid_work'));
    }

    return this.#emit(
      {
        workId: spec.workId,
        correlationSource: 'local',
        origin: 'replay',
        depth: 0,
        operation: spec.operation,
        attribution: spec.attribution,
        replay: { runId: spec.runId, source: spec.source },
      },
      spec.executor,
      1,
      undefined,
      spec.source.kind === 'scope' ? [spec.source.id] : [],
    );
  }

  enter(
    spec: RootSpec,
    incoming: IncomingResult,
  ): Result<Scope, Failure> {
    if (!validIncoming(incoming)) {
      return err(invalid('invalid_incoming_result'));
    }

    const work = rootWork(spec);
    if (!work.ok) return work;

    if (incoming.decision === 'continued') {
      work.value.correlationId = incoming.correlation;
      work.value.correlationSource = 'external';
      work.value.causation = incoming.cause;
      work.value.origin = undefined;
      work.value.depth = undefined;
    }

    return this.#emit(work.value, spec.executor, 1);
  }
}
