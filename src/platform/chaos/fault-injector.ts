import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../shared/errors/index.js';

/** Fault points currently exposed by the local event transport. */
export type ChaosPoint =
  | 'event.publish.before'
  | 'event.publish.after'
  | 'event.consume.before'
  | 'event.consume.after'
  | 'publisher.publish.before'
  | 'publisher.publish.after'
  | 'outbox.dispatch.before'
  | 'outbox.dispatch.after'
  | 'database.transaction.before'
  | 'database.transaction.after';

export type ChaosFault = Readonly<{
  point: ChaosPoint;
  action: 'fail' | 'delay';
  /** Number of matching calls to affect. Omit for one call; use "always" for all. */
  times?: number | 'always';
  delayMs?: number;
  failure?: Failure;
}>;

export type ChaosObservation = Readonly<{
  point: ChaosPoint;
  action: ChaosFault['action'];
  affected: boolean;
  observedAt: number;
}>;

type ArmedFault = ChaosFault & { remaining: number | 'always' };

function defaultFailure(point: ChaosPoint): Failure {
  return failure('unavailable', `chaos fault injected at ${point}`, {
    type: `chaos.${point}`,
    fields: { point },
  });
}

function canceled(): Failure {
  return failure('canceled', 'chaos delay was canceled', {
    type: 'chaos.canceled',
  });
}

function sleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<Result<void, Failure>> {
  if (signal?.aborted) return Promise.resolve(err(canceled()));

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(err(canceled()));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(ok(undefined));
    }, milliseconds);
  });
}

/**
 * Deterministic, opt-in fault control for integration tests.
 *
 * The injector does not catch application errors or retry operations. It only
 * inserts an explicit failure/delay at a named boundary and records what was
 * observed, leaving recovery policy to the system under test.
 */
export class FaultInjector {
  readonly #faults = new Map<ChaosPoint, ArmedFault>();
  readonly #observations: ChaosObservation[] = [];

  arm(fault: ChaosFault): void {
    const remaining = fault.times ?? 1;
    if (
      remaining !== 'always' &&
      (!Number.isSafeInteger(remaining) || remaining < 1)
    ) {
      throw new TypeError(
        'chaos fault times must be a positive integer or always',
      );
    }
    if (
      fault.action === 'delay' &&
      (!Number.isSafeInteger(fault.delayMs) || fault.delayMs! < 0)
    ) {
      throw new TypeError('chaos delayMs must be a non-negative integer');
    }

    this.#faults.set(fault.point, { ...fault, remaining });
  }

  disarm(point: ChaosPoint): void {
    this.#faults.delete(point);
  }

  reset(): void {
    this.#faults.clear();
    this.#observations.length = 0;
  }

  observations(): readonly ChaosObservation[] {
    return this.#observations.map((observation) => ({ ...observation }));
  }

  async hit(
    point: ChaosPoint,
    signal?: AbortSignal,
  ): Promise<Result<void, Failure>> {
    const fault = this.#faults.get(point);
    if (!fault) return ok(undefined);

    const affected = fault.remaining === 'always' || fault.remaining > 0;
    this.#observations.push({
      point,
      action: fault.action,
      affected,
      observedAt: Date.now(),
    });

    if (!affected) return ok(undefined);
    if (fault.remaining !== 'always') {
      fault.remaining -= 1;
      if (fault.remaining === 0) this.#faults.delete(point);
    }

    if (fault.action === 'fail') {
      return err(fault.failure ?? defaultFailure(point));
    }

    return sleep(fault.delayMs ?? 0, signal);
  }
}
