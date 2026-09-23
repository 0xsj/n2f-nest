import { err, type Failure, type Result } from '../../shared/errors/index.js';
import type { Envelope, Receipt } from '../../shared/events/index.js';
import type { EventBus, EventSubscriber } from '../events/event-bus.js';
import { FaultInjector } from './fault-injector.js';

/**
 * Test adapter that injects faults around a real EventBus.
 *
 * A failure at `event.consume.after` or `event.publish.after` models the
 * ambiguous window where a subscriber or publisher has already done work but
 * the caller did not receive a successful acknowledgement.
 */
export class ChaosEventBus implements EventBus {
  constructor(
    private readonly delegate: EventBus,
    private readonly faults: FaultInjector,
  ) {}

  subscribe(consumer: string, subscriber: EventSubscriber): () => void {
    return this.delegate.subscribe(consumer, async (event, signal) => {
      const before = await this.faults.hit('event.consume.before', signal, { consumer });
      if (!before.ok) return before;

      const result = await subscriber(event, signal);
      if (!result.ok) return result;

      const after = await this.faults.hit('event.consume.after', signal, { consumer });
      return after.ok ? after : err(after.error);
    });
  }

  async publish(
    event: Envelope,
    signal?: AbortSignal,
  ): Promise<Result<Receipt, Failure>> {
    const before = await this.faults.hit('event.publish.before', signal);
    if (!before.ok) return before;

    const result = await this.delegate.publish(event, signal);
    if (!result.ok) return result;

    const after = await this.faults.hit('event.publish.after', signal);
    return after.ok ? result : err(after.error);
  }
}
