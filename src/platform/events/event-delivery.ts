import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { err, failure, ok, type Failure, type Result } from '../../shared/errors/index.js';
import {
  CONSUMER_NAME,
  DEFAULT_RETRY,
  type Envelope,
  type Inbox,
  type Receipt,
  type RetryPolicy,
} from '../../shared/events/index.js';
import type { EventBus, EventSubscriber } from './event-bus.js';
import type { MetricsRegistry } from '../../shared/metrics/index.js';
import { METRICS } from '../metrics/metrics.tokens.js';

export const EVENT_INBOX = Symbol('platform.events.inbox');
/** Optional override of the delivery retry schedule (tests use a fast one). */
export const EVENT_RETRY_POLICY = Symbol('platform.events.retryPolicy');

const IDLE_MS = 250;

/**
 * The application's event bus. Publishing records the event in the inbox for
 * every named consumer and returns; it never runs a subscriber. One delivery
 * loop per consumer then leases due events from the inbox, so each consumer
 * retries with backoff and dead-letters on its own, and no consumer's failure
 * can fail or undo the write that produced the event (hardening item B4).
 *
 * Writers publish here directly in memory mode. In PostgreSQL mode the outbox
 * dispatcher, or the NATS worker, publishes here after the writer's
 * transaction has committed.
 */
@Injectable()
export class EventDelivery implements EventBus, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('EventDelivery');
  readonly #subscribers = new Map<string, EventSubscriber>();
  readonly #loops = new Map<string, Promise<void>>();
  #waiters = new Set<() => void>();
  #abort?: AbortController;

  constructor(
    @Inject(EVENT_INBOX) private readonly inbox: Inbox,
    @Optional()
    @Inject(EVENT_RETRY_POLICY)
    private readonly policy: RetryPolicy = DEFAULT_RETRY,
    @Optional()
    @Inject(METRICS)
    private readonly metrics?: MetricsRegistry,
  ) {}

  subscribe(consumer: string, subscriber: EventSubscriber): () => void {
    if (!CONSUMER_NAME.test(consumer)) {
      throw new TypeError(`invalid event consumer name: ${consumer}`);
    }
    if (this.#subscribers.has(consumer)) {
      throw new TypeError(`event consumer already subscribed: ${consumer}`);
    }
    this.#subscribers.set(consumer, subscriber);
    if (this.#abort) this.#start(consumer);
    return () => {
      this.#subscribers.delete(consumer);
    };
  }

  consumers(): readonly string[] {
    return [...this.#subscribers.keys()];
  }

  async publish(event: Envelope, signal?: AbortSignal): Promise<Result<Receipt, Failure>> {
    if (signal?.aborted) return err(failure('canceled', 'event publication canceled'));
    const accepted = await this.inbox.accept(event, this.consumers(), signal);
    if (!accepted.ok) return accepted;
    this.#wake();
    return ok({ eventId: event.id, durable: this.inbox.durable });
  }

  onApplicationBootstrap(): void {
    this.#abort = new AbortController();
    for (const consumer of this.#subscribers.keys()) this.#start(consumer);
  }

  async onModuleDestroy(): Promise<void> {
    this.#abort?.abort();
    this.#wake();
    await Promise.all(this.#loops.values());
    this.#loops.clear();
  }

  #start(consumer: string): void {
    if (this.#loops.has(consumer)) return;
    this.#loops.set(consumer, this.#run(consumer));
  }

  async #run(consumer: string): Promise<void> {
    const signal = this.#abort!.signal;
    while (!signal.aborted) {
      const subscriber = this.#subscribers.get(consumer);
      if (!subscriber) break;
      const delivered = await this.inbox.deliver(consumer, subscriber, this.policy, signal);
      if (signal.aborted) break;
      if (!delivered.ok) {
        this.logger.error(
          `event delivery to ${consumer} failed: ${delivered.error.type ?? delivered.error.kind}`,
        );
        await this.#idle(IDLE_MS, signal);
        continue;
      }
      const delivery = delivered.value;
      if (!delivery) {
        await this.#idle(IDLE_MS, signal);
        continue;
      }
      this.metrics?.add('n2f_event_deliveries_total', { consumer, outcome: delivery.outcome }, 1);
      if (delivery.outcome === 'retrying') {
        this.logger.warn(
          `${consumer} failed ${delivery.eventType} ${delivery.eventId} ` +
            `(attempt ${delivery.attempt}): ${delivery.error}; retrying`,
        );
      } else if (delivery.outcome === 'dead') {
        this.logger.error(
          `${consumer} dead-lettered ${delivery.eventType ?? 'an event'} ${delivery.eventId} ` +
            `after attempt ${delivery.attempt}: ${delivery.error}`,
        );
      }
    }
    this.#loops.delete(consumer);
  }

  /** Wait until the next poll, a newly published event, or shutdown. */
  #idle(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      this.#waiters.add(done);
    });
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = new Set();
    for (const waiter of waiters) waiter();
  }
}
