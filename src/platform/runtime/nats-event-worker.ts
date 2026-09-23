import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Broker } from '../../shared/events/nats/index.js';
import {
  EVENT_BUS,
  type EventBus,
} from '../events/event-bus.js';
import { NATS_BROKER } from './tokens.js';

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

/**
 * Moves JetStream deliveries into the durable inbox, then acknowledges them.
 * Subscribers run later from the inbox, so a slow or failing subscriber never
 * holds a JetStream acknowledgement.
 */
@Injectable()
export class NatsEventWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('NatsEventWorker');
  private active = false;
  private abort?: AbortController;
  private pollTask?: Promise<void>;

  constructor(
    @Inject(NATS_BROKER) private readonly broker: Broker | undefined,
    @Inject(EVENT_BUS) private readonly sink: EventBus,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.broker) return;
    this.active = true;
    this.abort = new AbortController();
    this.pollTask = this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    this.active = false;
    this.abort?.abort();
    await this.pollTask;
    this.pollTask = undefined;
    await this.broker?.close();
  }

  private async poll(): Promise<void> {
    while (this.active && this.broker) {
      const result = await this.broker.transfer(
        this.sink,
        this.abort?.signal,
      );
      if (!this.active) return;

      if (!result.ok) {
        this.logger.error(
          `NATS event transfer failed: ${result.error.type ?? result.error.kind}`,
        );
        await wait(POLL_MS, this.abort?.signal);
        continue;
      }

      await wait(result.value ? 10 : POLL_MS, this.abort?.signal);
    }
  }
}
