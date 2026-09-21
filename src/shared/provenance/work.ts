import {
  err,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';
import type { ID } from '../id/index.js';
import {
  invalid,
} from './actor.js';
import { validAttribution, type Attribution } from './attribution.js';
import { validOperation, type Operation } from './operation.js';
import {
  validID,
  validReference,
  type Reference,
} from './reference.js';

export type Origin =
  | 'request'
  | 'message'
  | 'schedule'
  | 'replay'
  | 'backfill'
  | 'startup';

export type CorrelationSource = 'local' | 'external';

export interface ReplayInfo {
  runId: ID;
  source: Reference;
}

export interface WorkSnapshot {
  workId: ID;
  correlationId: ID;
  correlationSource: CorrelationSource;
  causation?: Reference;
  origin?: Origin;
  operation: Operation;
  attribution: Attribution;
  depth?: number;
  replay?: ReplayInfo;
}

export type DraftWork = Omit<
  WorkSnapshot,
  'workId' | 'correlationId' | 'replay'
> & {
  workId?: ID;
  correlationId?: ID;
  replay?: { runId?: ID; source: Reference };
};

export const validOrigin = (value: unknown): value is Origin =>
  [
    'request',
    'message',
    'schedule',
    'replay',
    'backfill',
    'startup',
  ].includes(value as string);

export function validateWork(
  work: DraftWork,
  defaults = false,
): Failure | undefined {
  if (!work || typeof work !== 'object') return invalid('invalid_work');
  if (
    (work.workId === undefined ? !defaults : !validID(work.workId)) ||
    (work.correlationId === undefined
      ? !defaults
      : !validID(work.correlationId)) ||
    !['local', 'external'].includes(work.correlationSource)
  ) {
    return invalid('invalid_work');
  }

  if (!validOperation(work.operation)) return invalid('invalid_operation');
  if (!validAttribution(work.attribution)) {
    return invalid('invalid_attribution');
  }
  if (work.origin !== undefined && !validOrigin(work.origin)) {
    return invalid('invalid_origin');
  }
  if ((work.replay !== undefined) !== (work.origin === 'replay')) {
    return invalid('invalid_origin');
  }

  if (work.causation !== undefined) {
    if (!validReference(work.causation)) {
      return invalid('invalid_reference');
    }
    if (work.causation.kind === 'work' && work.causation.id === work.workId) {
      return invalid('invalid_work');
    }
  }

  if (work.depth !== undefined) {
    if (
      !Number.isInteger(work.depth) ||
      work.depth < 0 ||
      work.depth > 4294967295 ||
      (work.correlationSource === 'local' &&
        work.depth === 0 &&
        work.causation !== undefined) ||
      (work.depth > 0 && work.causation === undefined)
    ) {
      return invalid('invalid_depth');
    }
  }

  if (work.replay !== undefined) {
    if (
      !work.replay ||
      !validReference(work.replay.source) ||
      (work.replay.runId === undefined
        ? !defaults
        : !validID(work.replay.runId))
    ) {
      return invalid('invalid_reference');
    }
    if (
      work.replay.source.kind === 'work' &&
      work.replay.source.id === work.workId
    ) {
      return invalid('invalid_work');
    }
  }
}

export function copyWork(work: WorkSnapshot): WorkSnapshot {
  return {
    ...work,
    replay:
      work.replay === undefined
        ? undefined
        : { ...work.replay },
  };
}

const token = Symbol('work');
const known = new WeakSet<object>();

export class WorkContext {
  readonly #data: WorkSnapshot;

  constructor(key: typeof token, data: WorkSnapshot) {
    if (key !== token) throw new TypeError('use restoreWork');
    this.#data = Object.freeze({
      ...copyWork(data),
      replay:
        data.replay === undefined
          ? undefined
          : Object.freeze({ ...data.replay }),
    });
    known.add(this);
    Object.freeze(this);
  }

  snapshot(): WorkSnapshot {
    return copyWork(this.#data);
  }
}

export const validWork = (value: unknown): value is WorkContext =>
  typeof value === 'object' && value !== null && known.has(value);

export function restoreWork(
  work: WorkSnapshot,
): Result<WorkContext, Failure> {
  const error = validateWork(work);
  return error ? err(error) : ok(new WorkContext(token, work));
}
