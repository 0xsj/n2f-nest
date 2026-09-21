/** Readiness checks required dependencies; liveness does not. */
import { type Failure, type Result } from '../errors/index.js';

export type Check = (
  signal: AbortSignal,
) => Promise<Result<void, Failure>>;

export class Gate {
  #state: 'starting' | 'serving' | 'draining' = 'starting';
  #busy = false;
  #checks: readonly Check[];

  constructor(
    private readonly budgetMs: number,
    checks: readonly Check[],
  ) {
    if (
      !Number.isInteger(budgetMs) ||
      budgetMs < 1 ||
      budgetMs > 5000 ||
      checks.length > 16 ||
      checks.some((check) => typeof check !== 'function')
    ) {
      throw new TypeError('invalid health configuration');
    }
    this.#checks = [...checks];
  }

  start(): boolean {
    if (this.#state !== 'starting') return false;
    this.#state = 'serving';
    return true;
  }

  drain(): void {
    this.#state = 'draining';
  }

  async ready(signal?: AbortSignal): Promise<boolean> {
    if (this.#state !== 'serving' || this.#busy || signal?.aborted) {
      return false;
    }

    this.#busy = true;
    const controller = new AbortController();
    let stop!: () => void;
    const stopped = new Promise<boolean>((resolve) => {
      stop = () => {
        controller.abort();
        resolve(false);
      };
    });
    const timer = setTimeout(stop, this.budgetMs);
    signal?.addEventListener('abort', stop, { once: true });
    const work = (async () => {
      try {
        for (const check of this.#checks) {
          if (controller.signal.aborted || !(await check(controller.signal)).ok) {
            return false;
          }
        }
        return true;
      } catch {
        return false;
      } finally {
        this.#busy = false;
      }
    })();

    try {
      return (
        (await Promise.race([work, stopped])) &&
        this.serving() &&
        !signal?.aborted
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
  }

  private serving(): boolean {
    return this.#state === 'serving';
  }
}
