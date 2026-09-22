import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { OUTBOX_DISPATCHER } from './tokens.js';
import type { OutboxDispatcher } from '../events/outbox-dispatcher.js';

const POLL_MS = 250;

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Local lifecycle coordinator for one-at-a-time PostgreSQL outbox delivery. */
@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('OutboxWorker');
  private active = false;
  private abort?: AbortController;
  private pollTask?: Promise<void>;

  constructor(
    @Inject(OUTBOX_DISPATCHER)
    private readonly dispatcher: OutboxDispatcher | undefined,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.dispatcher) return;
    this.active = true;
    this.abort = new AbortController();
    this.pollTask = this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    this.active = false;
    this.abort?.abort();
    await this.pollTask;
    this.pollTask = undefined;
  }

  private async poll(): Promise<void> {
    while (this.active && this.dispatcher) {
      const result = await this.dispatcher.dispatchOnce(this.abort?.signal);
      if (!this.active) return;

      if (!result.ok) {
        this.logger.error(
          `outbox delivery attempt failed: ${result.error.type ?? result.error.kind}`,
        );
        await wait(POLL_MS, this.abort?.signal);
        continue;
      }

      await wait(result.value ? 10 : POLL_MS, this.abort?.signal);
    }
  }
}
