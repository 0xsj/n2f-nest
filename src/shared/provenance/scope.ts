import { err, ok, type Failure, type Result } from '../errors/index.js';
import type { ID } from '../id/index.js';
import {
  invalid,
  namedActor,
  type Actor,
} from './actor.js';
import { validID } from './reference.js';
import {
  restoreWork,
  WorkContext,
  type WorkSnapshot,
} from './work.js';

export interface ScopeSnapshot {
  work: WorkSnapshot;
  scopeId: ID;
  startedAt: Date;
  executor: Actor;
  attempt: number;
  previousAttempt?: ID;
}

export function normalizedTime(time: Date): number | undefined {
  if (!(time instanceof Date)) return undefined;
  const milliseconds = Date.prototype.getTime.call(time);
  if (
    Number.isSafeInteger(milliseconds) &&
    milliseconds >= 0 &&
    milliseconds <= 281474976710655
  ) {
    return milliseconds;
  }
  return undefined;
}

const token = Symbol('scope');
const known = new WeakSet<object>();

export class Scope {
  readonly #work: WorkContext;
  readonly #data: Omit<ScopeSnapshot, 'work' | 'startedAt'>;
  readonly #started: number;

  constructor(
    key: typeof token,
    snapshot: ScopeSnapshot,
    work: WorkContext,
    started: number,
  ) {
    if (key !== token) throw new TypeError('use restoreScope');
    this.#work = work;
    this.#data = Object.freeze({
      scopeId: snapshot.scopeId,
      executor: snapshot.executor,
      attempt: snapshot.attempt,
      previousAttempt: snapshot.previousAttempt,
    });
    this.#started = started;
    known.add(this);
    Object.freeze(this);
  }

  snapshot(): ScopeSnapshot {
    return {
      ...this.#data,
      work: this.#work.snapshot(),
      startedAt: new Date(this.#started),
    };
  }

  workContext(): WorkContext {
    return this.#work;
  }
}

export const validScope = (value: unknown): value is Scope =>
  typeof value === 'object' && value !== null && known.has(value);

export function restoreScope(
  snapshot: ScopeSnapshot,
): Result<Scope, Failure> {
  if (!snapshot || !validID(snapshot.scopeId)) {
    return err(invalid('invalid_scope'));
  }

  const work = restoreWork(snapshot.work);
  if (!work.ok) return work;
  if (!namedActor(snapshot.executor)) {
    return err(invalid('invalid_actor'));
  }
  if (
    !Number.isInteger(snapshot.attempt) ||
    snapshot.attempt < 1 ||
    snapshot.attempt > 4294967295
  ) {
    return err(invalid('invalid_attempt'));
  }
  if (
    snapshot.previousAttempt !== undefined &&
    (!validID(snapshot.previousAttempt) ||
      snapshot.previousAttempt === snapshot.scopeId ||
      snapshot.attempt === 1)
  ) {
    return err(invalid('invalid_scope'));
  }
  if (
    snapshot.work.causation?.kind === 'scope' &&
    snapshot.work.causation.id === snapshot.scopeId
  ) {
    return err(invalid('invalid_scope'));
  }

  const milliseconds = normalizedTime(snapshot.startedAt);
  if (milliseconds === undefined) return err(invalid('invalid_time'));
  return ok(new Scope(token, snapshot, work.value, milliseconds));
}
