import type { Envelope, Publisher } from '../../shared/events/index.js';
import type { Failure, Result } from '../../shared/errors/index.js';

export type EventSubscriber = (
  event: Envelope,
  signal?: AbortSignal,
) => Promise<Result<void, Failure>>;

/**
 * Platform boundary for publishing and consuming application events.
 *
 * Modules depend on this contract, not on the process-local implementation.
 * The adapter can therefore move from in-process delivery to an outbox/NATS
 * dispatcher without changing domain or application code.
 */
export interface EventBus extends Publisher {
  /**
   * Register a named consumer. Each consumer receives every event published
   * after it subscribed, retries independently, and must be idempotent by
   * event ID because delivery is at least once.
   */
  subscribe(consumer: string, subscriber: EventSubscriber): () => void;
}

export const EVENT_BUS = Symbol('platform.events.eventBus');
