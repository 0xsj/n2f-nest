import type { Failure, Result } from '../errors/index.js';
import type { Envelope } from './index.js';
import type { RetryPolicy } from './retry.js';

/** A named consumer's handler. A failure schedules a retry for that consumer only. */
export type EventHandler = (
  event: Envelope,
  signal?: AbortSignal,
) => Promise<Result<void, Failure>>;

/** The outcome of one delivery attempt. */
export type Delivery = Readonly<{
  eventId: string;
  eventType: string | null;
  attempt: number;
  outcome: 'processed' | 'retrying' | 'dead';
  /** Failure type of a failed attempt, or `events.undecodable` for a quarantined row. */
  error?: string;
}>;

/**
 * Durable per-consumer delivery ledger ("transactional inbox").
 *
 * `accept` records an event once and opens one delivery for each named
 * consumer. `deliver` hands the next due event to one consumer's handler under
 * a lease, so each consumer succeeds, retries and dead-letters independently,
 * and a slow or failing consumer never affects the producer or other consumers.
 * Delivery is at least once: handlers must be idempotent by event ID.
 */
export interface Inbox {
  /** Whether accepted events survive a process restart. */
  readonly durable: boolean;

  accept(
    event: Envelope,
    consumers: readonly string[],
    signal?: AbortSignal,
  ): Promise<Result<void, Failure>>;

  deliver(
    consumer: string,
    handler: EventHandler,
    policy: RetryPolicy,
    signal?: AbortSignal,
  ): Promise<Result<Delivery | null, Failure>>;

  /** Return a consumer's dead deliveries (one, or all) to the queue. */
  requeue(consumer: string, eventId?: string): Promise<Result<number, Failure>>;

  /** Deliveries not yet processed, per consumer and state, for monitoring. */
  backlog(signal?: AbortSignal): Promise<Result<readonly InboxBacklog[], Failure>>;
}

export type InboxBacklog = Readonly<{
  consumer: string;
  state: 'pending' | 'dead';
  count: number;
}>;

export const CONSUMER_NAME = /^[a-z0-9_.-]{1,64}$/;
