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

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Local lifecycle coordinator for one-at-a-time PostgreSQL outbox delivery. */
@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('OutboxWorker');
  private active = false;
  private abort?: AbortController;

  constructor(
    @Inject(OUTBOX_DISPATCHER)
    private readonly dispatcher: OutboxDispatcher | undefined,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.dispatcher) return;
    this.active = true;
    this.abort = new AbortController();
    void this.poll();
  }

  onModuleDestroy(): void {
    this.active = false;
    this.abort?.abort();
  }

  private async poll(): Promise<void> {
    while (this.active && this.dispatcher) {
      const result = await this.dispatcher.dispatchOnce(this.abort?.signal);
      if (!this.active) return;

      if (!result.ok) {
        this.logger.error(
          `outbox delivery attempt failed: ${result.error.type ?? result.error.kind}`,
        );
        await wait(POLL_MS);
        continue;
      }

      await wait(result.value ? 10 : POLL_MS);
    }
  }
}
