import { err, failure, ok, type Failure, type Result } from '../errors/index.js';
import type { Envelope } from './index.js';
import {
  CONSUMER_NAME,
  type Delivery,
  type EventHandler,
  type Inbox,
  type InboxBacklog,
} from './inbox.js';
import { exhausted, retryDelay, type RetryPolicy } from './retry.js';

type Receipt = {
  state: 'pending' | 'processed' | 'dead';
  attempts: number;
  availableAt: number;
  leased: boolean;
  sequence: number;
};

/**
 * Process-local inbox with the same per-consumer semantics as the PostgreSQL
 * inbox. It is not durable: accepted events are lost when the process exits.
 */
export class InMemoryInbox implements Inbox {
  readonly durable = false;
  readonly #events = new Map<string, Envelope>();
  readonly #receipts = new Map<string, Map<string, Receipt>>();
  #sequence = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async accept(
    event: Envelope,
    consumers: readonly string[],
  ): Promise<Result<void, Failure>> {
    const existing = this.#events.get(event.id);
    if (existing && !sameBytes(existing, event)) {
      return err(
        failure('conflict', 'event delivery conflict', { type: 'events.id_reused' }),
      );
    }
    this.#events.set(event.id, event);
    for (const consumer of consumers) {
      if (!CONSUMER_NAME.test(consumer)) return err(invalidConsumer());
      const receipts = this.#receiptsFor(consumer);
      if (!receipts.has(event.id)) {
        receipts.set(event.id, {
          state: 'pending',
          attempts: 0,
          availableAt: this.now(),
          leased: false,
          sequence: this.#sequence++,
        });
      }
    }
    return ok(undefined);
  }

  async deliver(
    consumer: string,
    handler: EventHandler,
    policy: RetryPolicy,
    signal?: AbortSignal,
  ): Promise<Result<Delivery | null, Failure>> {
    if (!CONSUMER_NAME.test(consumer)) return err(invalidConsumer());
    const now = this.now();
    let next: [string, Receipt] | undefined;
    for (const entry of this.#receiptsFor(consumer)) {
      const receipt = entry[1];
      if (receipt.state !== 'pending' || receipt.leased || receipt.availableAt > now) continue;
      if (
        !next ||
        receipt.availableAt < next[1].availableAt ||
        (receipt.availableAt === next[1].availableAt && receipt.sequence < next[1].sequence)
      ) {
        next = entry;
      }
    }
    if (!next) return ok(null);

    const [eventId, receipt] = next;
    const event = this.#events.get(eventId)!;
    receipt.leased = true;
    receipt.attempts += 1;
    const attempt = receipt.attempts;
    let result: Result<void, Failure>;
    try {
      result = await handler(event, signal);
    } catch (cause) {
      result = err(failure('internal', 'event handler threw', { type: 'events.handler_threw', cause }));
    } finally {
      receipt.leased = false;
    }

    if (result.ok) {
      receipt.state = 'processed';
      return ok({ eventId, eventType: event.type, attempt, outcome: 'processed' });
    }
    const dead = exhausted(policy, attempt);
    receipt.state = dead ? 'dead' : 'pending';
    receipt.availableAt = this.now() + retryDelay(policy, attempt);
    return ok({
      eventId,
      eventType: event.type,
      attempt,
      outcome: dead ? 'dead' : 'retrying',
      error: result.error.type ?? result.error.kind,
    });
  }

  async requeue(consumer: string, eventId?: string): Promise<Result<number, Failure>> {
    if (!CONSUMER_NAME.test(consumer)) return err(invalidConsumer());
    let count = 0;
    for (const [id, receipt] of this.#receiptsFor(consumer)) {
      if (receipt.state !== 'dead' || (eventId !== undefined && id !== eventId)) continue;
      receipt.state = 'pending';
      receipt.attempts = 0;
      receipt.availableAt = this.now();
      count += 1;
    }
    return ok(count);
  }

  async backlog(): Promise<Result<readonly InboxBacklog[], Failure>> {
    const backlog: InboxBacklog[] = [];
    for (const [consumer, receipts] of this.#receipts) {
      for (const state of ['pending', 'dead'] as const) {
        const count = [...receipts.values()].filter((receipt) => receipt.state === state).length;
        backlog.push({ consumer, state, count });
      }
    }
    return ok(backlog);
  }

  /** Deliveries for a consumer that are not processed (pending or dead). */
  unsettled(consumer: string): number {
    return [...this.#receiptsFor(consumer).values()].filter(
      (receipt) => receipt.state !== 'processed',
    ).length;
  }

  /** Dead deliveries for a consumer, for tests and operators. */
  dead(consumer: string): readonly string[] {
    return [...this.#receiptsFor(consumer)]
      .filter(([, receipt]) => receipt.state === 'dead')
      .map(([eventId]) => eventId);
  }

  #receiptsFor(consumer: string): Map<string, Receipt> {
    let receipts = this.#receipts.get(consumer);
    if (!receipts) {
      receipts = new Map();
      this.#receipts.set(consumer, receipts);
    }
    return receipts;
  }
}

function sameBytes(left: Envelope, right: Envelope): boolean {
  return Buffer.from(left.bytes()).equals(Buffer.from(right.bytes()));
}

function invalidConsumer(): Failure {
  return failure('invalid', 'invalid event consumer', { type: 'events.invalid_consumer' });
}
