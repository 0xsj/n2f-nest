import {
  err,
  ok,
  failure,
  type Result,
  type Failure,
} from '../../../shared/errors/index.js';

/** Bounded concurrency and queueing for hash work (H06–H08). */
export type Limits = Readonly<{
  maxConcurrent: number;
  maxQueued: number;
  queueWaitMs: number;
}>;
export const configuration = (): Failure =>
  failure('invalid', 'invalid password hasher configuration', {
    type: 'identity.hasher_configuration',
  });
export const validLimits = (l: unknown): l is Limits =>
  typeof l === 'object' &&
  l !== null &&
  Number.isSafeInteger((l as Limits).maxConcurrent) &&
  (l as Limits).maxConcurrent >= 1 &&
  Number.isSafeInteger((l as Limits).maxQueued) &&
  (l as Limits).maxQueued >= 0 &&
  Number.isSafeInteger((l as Limits).queueWaitMs) &&
  (l as Limits).queueWaitMs >= 1;
type Waiter = { settle: (r: Result<void, Failure>) => void };
export type Release = () => void;

/** Admission refusals never consume a slot; an admitted caller must release. */
export class Admission {
  #active = 0;
  readonly #queue: Waiter[] = [];
  constructor(private readonly limits: Limits) {}
  acquire(signal?: AbortSignal): Promise<Result<Release, Failure>> {
    if (signal?.aborted) return Promise.resolve(err(canceled()));
    if (this.#active < this.limits.maxConcurrent) {
      this.#active++;
      return Promise.resolve(ok(this.#release()));
    }
    if (this.#queue.length >= this.limits.maxQueued)
      return Promise.resolve(err(saturated()));
    return new Promise((resolve) => {
      const waiter: Waiter = {
        settle: (r) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(r.ok ? ok(this.#release()) : err(r.error));
        },
      };
      const drop = (fail: Failure) => {
        const at = this.#queue.indexOf(waiter);
        if (at >= 0) {
          this.#queue.splice(at, 1);
          waiter.settle(err(fail));
        }
      };
      const timer = setTimeout(() => drop(timedOut()), this.limits.queueWaitMs);
      const onAbort = () => drop(canceled());
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#queue.push(waiter);
    });
  }
  #release(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#queue.shift();
      if (next) next.settle(ok(undefined));
      else this.#active--;
    };
  }
}
const saturated = () =>
  failure('unavailable', 'password hashing is saturated', {
    type: 'identity.hash_saturated',
  });
const timedOut = () =>
  failure('timeout', 'password hashing queue wait exceeded', {
    type: 'identity.hash_queue_timeout',
  });
const canceled = () =>
  failure('canceled', 'password hashing request canceled', {
    type: 'identity.hash_canceled',
  });
