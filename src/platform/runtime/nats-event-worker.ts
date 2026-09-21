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
import { DurableInProcessPublisher } from '../events/durable-in-process-publisher.js';
import { NATS_BROKER } from './tokens.js';

const POLL_MS = 250;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Bridges one JetStream delivery into local subscribers before ACK. */
@Injectable()
export class NatsEventWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('NatsEventWorker');
  private readonly sink: DurableInProcessPublisher;
  private active = false;
  private abort?: AbortController;

  constructor(
    @Inject(NATS_BROKER) private readonly broker: Broker | undefined,
    @Inject(EVENT_BUS) bus: EventBus,
  ) {
    this.sink = new DurableInProcessPublisher(bus);
  }

  onApplicationBootstrap(): void {
    if (!this.broker) return;
    this.active = true;
    this.abort = new AbortController();
    void this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    this.active = false;
    this.abort?.abort();
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
        await wait(POLL_MS);
        continue;
      }

      await wait(result.value ? 10 : POLL_MS);
    }
  }
}
