import {
  ok,
  type Failure,
  type Result,
} from '../../shared/errors/index.js';
import type { Envelope, Publisher, Receipt } from '../../shared/events/index.js';
import type { EventBus } from './event-bus.js';

/**
 * Adapts local subscriber completion to the durable receipt expected by the
 * outbox and NATS consumer seams. It is only a process-local transport.
 */
export class DurableInProcessPublisher implements Publisher {
  constructor(private readonly bus: EventBus) {}

  async publish(
    event: Envelope,
    signal?: AbortSignal,
  ): Promise<Result<Receipt, Failure>> {
    const result = await this.bus.publish(event, signal);
    return result.ok
      ? ok({ eventId: event.id, durable: true })
      : result;
  }
}
