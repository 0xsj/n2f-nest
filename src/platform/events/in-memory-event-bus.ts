import { Injectable } from '@nestjs/common';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../shared/errors/index.js';
import type { Envelope, Receipt } from '../../shared/events/index.js';
import type { EventBus, EventSubscriber } from './event-bus.js';

/** Process-local Publisher used only until an outbox/NATS dispatcher is wired. */
@Injectable()
export class InMemoryEventBus implements EventBus {
  readonly #subscribers = new Set<EventSubscriber>();

  subscribe(subscriber: EventSubscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  async publish(
    event: Envelope,
    signal?: AbortSignal,
  ): Promise<Result<Receipt, Failure>> {
    if (signal?.aborted) {
      return err(failure('canceled', 'event publication canceled'));
    }

    for (const subscriber of this.#subscribers) {
      const result = await subscriber(event, signal);
      if (!result.ok) return result;
    }

    return ok({ eventId: event.id, durable: false });
  }
}
