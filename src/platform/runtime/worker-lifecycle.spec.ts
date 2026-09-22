import { describe, expect, it } from 'vitest';
import { ok } from '../../shared/errors/index.js';
import { OutboxWorker } from './outbox-worker.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('background worker lifecycle', () => {
  it('awaits an in-flight outbox attempt after cancellation', async () => {
    const attempt = deferred<ReturnType<typeof ok<boolean>>>();
    let signal: AbortSignal | undefined;
    const dispatcher = {
      dispatchOnce: (caller?: AbortSignal) => {
        signal = caller;
        return attempt.promise;
      },
    };
    const worker = new OutboxWorker(dispatcher as never);

    worker.onApplicationBootstrap();
    await Promise.resolve();

    const stopping = worker.onModuleDestroy();
    expect(signal?.aborted).toBe(true);

    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    attempt.resolve(ok(false));
    await stopping;
    expect(settled).toBe(true);
  });
});
