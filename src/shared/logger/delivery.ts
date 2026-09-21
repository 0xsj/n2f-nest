import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';
import type { Sink } from './config.js';

export interface Stats {
  accepted: number;
  written: number;
  dropped: number;
  failed: number;
}

export class Delivery {
  readonly counts: Stats = {
    accepted: 0,
    written: 0,
    dropped: 0,
    failed: 0,
  };
  closed = false;
  readonly #queue: string[] = [];
  #running = false;
  #finish!: () => void;
  readonly #done = new Promise<void>((resolve) => {
    this.#finish = resolve;
  });

  constructor(
    readonly sink: Sink,
    readonly capacity: number,
    readonly maxBytes: number,
    readonly noop: boolean,
  ) {}

  write(line: string): void {
    if (
      this.closed ||
      Buffer.byteLength(line, 'utf8') > this.maxBytes ||
      (this.#running && this.#queue.length >= this.capacity)
    ) {
      this.counts.dropped += 1;
      return;
    }

    this.counts.accepted += 1;
    this.#queue.push(line);
    if (!this.#running) void this.#pump();
  }

  async #pump(): Promise<void> {
    this.#running = true;
    while (this.#queue.length) {
      const line = this.#queue.shift()!;
      try {
        await this.sink.write(line);
        this.counts.written += 1;
      } catch {
        this.counts.failed += 1;
      }
    }
    this.#running = false;
    if (this.closed) await this.#flush();
  }

  async #flush(): Promise<void> {
    try {
      if (!this.noop) await this.sink.flush?.();
    } catch {
      this.counts.failed += 1;
    } finally {
      this.#finish();
    }
  }

  async close(timeoutMs: number): Promise<Result<void, Failure>> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      return err(
        failure('invalid', 'invalid flush deadline', {
          type: 'logger.invalid_configuration',
        }),
      );
    }

    if (!this.closed) {
      this.closed = true;
      if (!this.#running) void this.#flush();
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      this.#done.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(
          () => resolve(true),
          Math.min(timeoutMs, 2147483647),
        );
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);

    if (timedOut) {
      return err(
        failure('timeout', 'log flush deadline exceeded', {
          type: 'logger.flush_timeout',
        }),
      );
    }
    return this.counts.failed
      ? err(failure('unavailable', 'log sink failed', { type: 'logger.sink' }))
      : ok(undefined);
  }
}
