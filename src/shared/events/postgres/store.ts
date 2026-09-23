import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { parse, type ID } from '../../id/index.js';
import { Database, map, type Migration } from '../../postgres/index.js';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../errors/index.js';
import { Envelope, type Publisher, type Receipt } from '../index.js';
import {
  CONSUMER_NAME,
  type Delivery,
  type EventHandler,
  type Inbox,
  type InboxBacklog,
} from '../inbox.js';
import { DEFAULT_RETRY, exhausted, retryDelay, type RetryPolicy } from '../retry.js';

/** The event outbox and inbox baseline schema; see migrations/baseline.sql. */
export const baselineMigration = (version: number): Migration => ({
  version,
  sql: readFileSync(new URL('./migrations/baseline.sql', import.meta.url), 'utf8'),
});

const LEASE = "interval '30 seconds'";
const UNDECODABLE = 'events.undecodable';

const conflict = (code: string) =>
  failure('conflict', 'event delivery conflict', { type: 'events.' + code });

async function insert(
  transaction: pg.PoolClient,
  table: 'outbox' | 'mailbox',
  event: Envelope,
): Promise<Result<void, Failure>> {
  try {
    const result = await transaction.query(
      'INSERT INTO public.n2f_' +
        table +
        ' AS t(event_id,envelope) VALUES($1::uuid,$2) ON CONFLICT(event_id) DO UPDATE SET envelope=t.envelope WHERE t.envelope::jsonb=excluded.envelope::jsonb',
      [event.id, Buffer.from(event.bytes()).toString()],
    );
    return result.rowCount === 1 ? ok(undefined) : err(conflict('id_reused'));
  } catch (error) {
    return err(map(error));
  }
}

export const enqueue = (transaction: pg.PoolClient, event: Envelope) =>
  insert(transaction, 'outbox', event);

export type Lease = { event: Envelope; token: ID; attempt: number };

export type OutboxStats = Readonly<{ pending: number; dead: number; oldestPendingSeconds: number }>;

/** A claimed row whose envelope could not be decoded; it has been quarantined. */
type Quarantined = { quarantined: string };

type Claimed =
  | null
  | { quarantined: string; attempt: number }
  | { event: Envelope; attempt: number };

/**
 * PostgreSQL outbox. Rows are claimed under a lease (`FOR UPDATE SKIP LOCKED`),
 * so several processes can dispatch concurrently and a crashed dispatcher's
 * lease simply expires. Failed publishes retry with exponential backoff;
 * exhausted rows become `dead` until an operator requeues them. A row whose
 * envelope no longer decodes is quarantined as `dead` instead of blocking the
 * queue.
 */
export class Store {
  constructor(
    readonly database: Database,
    private readonly policy: RetryPolicy = DEFAULT_RETRY,
    private readonly random: () => number = Math.random,
  ) {}

  async claim(token: ID): Promise<Result<Lease | Quarantined | undefined, Failure>> {
    const valid = parse(token);
    if (!valid.ok) return valid;
    return this.database.transaction<Lease | Quarantined | undefined>(async (transaction) => {
      // A dispatcher that crashed on its final attempt leaves an exhausted row.
      await transaction.query(
        `UPDATE public.n2f_outbox
            SET state='dead',lease=NULL,lease_until=NULL,finished_at=clock_timestamp(),
                last_error=COALESCE(last_error,'events.lease_expired')
          WHERE state='pending' AND attempts>=$1
            AND (lease_until IS NULL OR lease_until<=clock_timestamp())`,
        [this.policy.maxAttempts],
      );
      const row = (
        await transaction.query<{ event_id: string; envelope: string; attempts: number }>(
          `WITH candidate AS (
             SELECT event_id FROM public.n2f_outbox
              WHERE state='pending' AND attempts<$2 AND available_at<=clock_timestamp()
                AND (lease_until IS NULL OR lease_until<=clock_timestamp())
              ORDER BY available_at,event_id
              FOR UPDATE SKIP LOCKED LIMIT 1)
           UPDATE public.n2f_outbox o
              SET lease=$1::uuid,lease_until=clock_timestamp()+${LEASE},attempts=o.attempts+1
             FROM candidate c WHERE o.event_id=c.event_id
           RETURNING o.event_id::text,o.envelope::text,o.attempts`,
          [token, this.policy.maxAttempts],
        )
      ).rows[0];
      if (!row) return ok(undefined);
      const event = Envelope.decode(Buffer.from(row.envelope));
      if (!event.ok) {
        await transaction.query(
          `UPDATE public.n2f_outbox
              SET state='dead',lease=NULL,lease_until=NULL,finished_at=clock_timestamp(),last_error=$2
            WHERE event_id=$1::uuid`,
          [row.event_id, UNDECODABLE],
        );
        return ok({ quarantined: row.event_id });
      }
      return ok({ event: event.value, token, attempt: row.attempts });
    });
  }

  ack(lease: Lease): Promise<Result<void, Failure>> {
    return this.finish(lease, undefined);
  }

  release(lease: Lease, error = 'events.publish_failed'): Promise<Result<void, Failure>> {
    return this.finish(lease, error);
  }

  private finish(lease: Lease, error: string | undefined): Promise<Result<void, Failure>> {
    const dead = error !== undefined && exhausted(this.policy, lease.attempt);
    const state = error === undefined ? 'sent' : dead ? 'dead' : 'pending';
    const delayMs = error === undefined ? 0 : retryDelay(this.policy, lease.attempt, this.random);
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE public.n2f_outbox
            SET state=$3,lease=NULL,lease_until=NULL,last_error=$4,
                available_at=clock_timestamp()+($5::integer*interval '1 millisecond'),
                finished_at=CASE WHEN $3='pending' THEN NULL ELSE clock_timestamp() END
          WHERE event_id=$1::uuid AND lease=$2::uuid AND state='pending'
            AND lease_until>clock_timestamp()`,
        [lease.event.id, lease.token, state, error?.slice(0, 200) ?? null, delayMs],
      );
      return result.rowCount === 1 ? ok(undefined) : err(conflict('lease_lost'));
    });
  }

  async dispatch(
    publisher: Publisher,
    token: ID,
    signal?: AbortSignal,
  ): Promise<Result<boolean, Failure>> {
    if (signal?.aborted) return err(failure('canceled', 'dispatch canceled'));
    const claimed = await this.claim(token);
    if (!claimed.ok) return claimed;
    if (!claimed.value) return ok(false);
    if ('quarantined' in claimed.value) return ok(true);

    const lease = claimed.value;
    let receipt: Result<Receipt, Failure>;
    try {
      receipt = await publisher.publish(lease.event, signal);
    } catch (error) {
      receipt = err(map(error));
    }
    if (
      receipt.ok &&
      receipt.value.durable &&
      receipt.value.eventId === lease.event.id
    ) {
      const acknowledged = await this.ack(lease);
      return acknowledged.ok ? ok(true) : acknowledged;
    }
    const released = await this.release(
      lease,
      receipt.ok ? 'events.invalid_receipt' : (receipt.error.type ?? receipt.error.kind),
    );
    if (!released.ok) return released;
    return receipt.ok
      ? err(
          failure('unavailable', 'publisher receipt invalid', {
            type: 'events.invalid_receipt',
          }),
        )
      : receipt;
  }

  /** Pending and dead row counts, and how long the oldest pending row has waited. */
  stats(): Promise<Result<OutboxStats, Failure>> {
    return this.database.transaction(async (transaction) => {
      const row = (
        await transaction.query<{ pending: string; dead: string; oldest: number | null }>(
          `SELECT count(*) FILTER (WHERE state='pending') AS pending,
                  count(*) FILTER (WHERE state='dead') AS dead,
                  EXTRACT(EPOCH FROM clock_timestamp()-min(available_at) FILTER (WHERE state='pending'))::float8 AS oldest
             FROM public.n2f_outbox WHERE state<>'sent'`,
        )
      ).rows[0];
      return ok({
        pending: Number(row?.pending ?? 0),
        dead: Number(row?.dead ?? 0),
        oldestPendingSeconds: Math.max(0, row?.oldest ?? 0),
      });
    });
  }

  /** Return dead rows (one, or all) to the queue with a fresh attempt budget. */
  requeue(eventId?: ID): Promise<Result<number, Failure>> {
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE public.n2f_outbox
            SET state='pending',attempts=0,available_at=clock_timestamp(),
                last_error=NULL,finished_at=NULL
          WHERE state='dead' AND ($1::uuid IS NULL OR event_id=$1::uuid)`,
        [eventId ?? null],
      );
      return ok(result.rowCount ?? 0);
    });
  }

  /** Delete up to `limit` sent rows finished more than `retentionMs` ago. */
  prune(retentionMs: number, limit = 1000): Promise<Result<number, Failure>> {
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query(
        `DELETE FROM public.n2f_outbox WHERE event_id IN (
           SELECT event_id FROM public.n2f_outbox
            WHERE state='sent'
              AND finished_at<clock_timestamp()-($1::bigint*interval '1 millisecond')
            LIMIT $2)`,
        [retentionMs, limit],
      );
      return ok(result.rowCount ?? 0);
    });
  }
}

/**
 * PostgreSQL inbox: the durable per-consumer delivery ledger behind local and
 * NATS event delivery. `accept` stores the envelope once and one receipt per
 * consumer; `deliver` leases one consumer's next due receipt, runs the handler
 * outside any transaction, then records the outcome under the same lease.
 */
export class Mailbox implements Inbox, Publisher {
  readonly durable = true;

  constructor(
    readonly database: Database,
    private readonly consumers: () => readonly string[] = () => [],
    private readonly random: () => number = Math.random,
  ) {}

  /** Publisher seam for the outbox dispatcher and the NATS worker. */
  async publish(
    event: Envelope,
    signal?: AbortSignal,
  ): Promise<Result<Receipt, Failure>> {
    const accepted = await this.accept(event, this.consumers(), signal);
    return accepted.ok ? ok({ eventId: event.id, durable: true }) : accepted;
  }

  accept(
    event: Envelope,
    consumers: readonly string[],
    signal?: AbortSignal,
  ): Promise<Result<void, Failure>> {
    if (consumers.some((consumer) => !CONSUMER_NAME.test(consumer))) {
      return Promise.resolve(err(invalidConsumer()));
    }
    return this.database.transaction(async (transaction) => {
      const stored = await insert(transaction, 'mailbox', event);
      if (!stored.ok) return stored;
      try {
        await transaction.query(
          `INSERT INTO public.n2f_mailbox_receipts(event_id,consumer)
           SELECT $1::uuid,consumer FROM unnest($2::text[]) AS consumer
           ON CONFLICT(event_id,consumer) DO NOTHING`,
          [event.id, [...consumers]],
        );
        return ok(undefined);
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }

  async deliver(
    consumer: string,
    handler: EventHandler,
    policy: RetryPolicy,
    signal?: AbortSignal,
  ): Promise<Result<Delivery | null, Failure>> {
    if (!CONSUMER_NAME.test(consumer)) return err(invalidConsumer());
    const token = randomUUID();

    const claimed = await this.database.transaction<Claimed>(async (transaction) => {
      await transaction.query(
        `UPDATE public.n2f_mailbox_receipts
            SET state='dead',lease=NULL,lease_until=NULL,finished_at=clock_timestamp(),
                last_error=COALESCE(last_error,'events.lease_expired')
          WHERE consumer=$1 AND state='pending' AND attempts>=$2
            AND (lease_until IS NULL OR lease_until<=clock_timestamp())`,
        [consumer, policy.maxAttempts],
      );
      const row = (
        await transaction.query<{ event_id: string; envelope: string; attempts: number }>(
          `WITH candidate AS (
             SELECT event_id FROM public.n2f_mailbox_receipts
              WHERE consumer=$1 AND state='pending' AND attempts<$3
                AND available_at<=clock_timestamp()
                AND (lease_until IS NULL OR lease_until<=clock_timestamp())
              ORDER BY available_at,event_id
              FOR UPDATE SKIP LOCKED LIMIT 1)
           UPDATE public.n2f_mailbox_receipts r
              SET lease=$2::uuid,lease_until=clock_timestamp()+${LEASE},attempts=r.attempts+1
             FROM candidate c, public.n2f_mailbox m
            WHERE r.event_id=c.event_id AND r.consumer=$1 AND m.event_id=c.event_id
           RETURNING r.event_id::text,m.envelope::text,r.attempts`,
          [consumer, token, policy.maxAttempts],
        )
      ).rows[0];
      if (!row) return ok(null);
      const event = Envelope.decode(Buffer.from(row.envelope));
      if (!event.ok) {
        await transaction.query(
          `UPDATE public.n2f_mailbox_receipts
              SET state='dead',lease=NULL,lease_until=NULL,finished_at=clock_timestamp(),last_error=$3
            WHERE event_id=$1::uuid AND consumer=$2`,
          [row.event_id, consumer, UNDECODABLE],
        );
        return ok({ quarantined: row.event_id, attempt: row.attempts });
      }
      return ok({ event: event.value, attempt: row.attempts });
    }, signal);
    if (!claimed.ok) return claimed;
    if (claimed.value === null) return ok(null);
    if ('quarantined' in claimed.value) {
      return ok({
        eventId: claimed.value.quarantined,
        eventType: null,
        attempt: claimed.value.attempt,
        outcome: 'dead',
        error: UNDECODABLE,
      });
    }

    const { event, attempt } = claimed.value;
    let result: Result<void, Failure>;
    try {
      result = await handler(event, signal);
    } catch (cause) {
      result = err(map(cause));
    }
    const error = result.ok ? undefined : (result.error.type ?? result.error.kind);
    const dead = error !== undefined && exhausted(policy, attempt);
    const state = error === undefined ? 'processed' : dead ? 'dead' : 'pending';
    const delayMs = error === undefined ? 0 : retryDelay(policy, attempt, this.random);

    const finished = await this.database.transaction(async (transaction) => {
      const updated = await transaction.query(
        `UPDATE public.n2f_mailbox_receipts
            SET state=$4,lease=NULL,lease_until=NULL,last_error=$5,
                available_at=clock_timestamp()+($6::integer*interval '1 millisecond'),
                finished_at=CASE WHEN $4='pending' THEN NULL ELSE clock_timestamp() END
          WHERE event_id=$1::uuid AND consumer=$2 AND lease=$3::uuid AND state='pending'`,
        [event.id, consumer, token, state, error?.slice(0, 200) ?? null, delayMs],
      );
      return updated.rowCount === 1 ? ok(undefined) : err(conflict('lease_lost'));
    });
    if (!finished.ok) return finished;
    return ok({
      eventId: event.id,
      eventType: event.type,
      attempt,
      outcome: state === 'processed' ? 'processed' : dead ? 'dead' : 'retrying',
      ...(error === undefined ? {} : { error }),
    });
  }

  /** Return a consumer's dead receipts (one, or all) to the queue. */
  requeue(consumer: string, eventId?: ID): Promise<Result<number, Failure>> {
    if (!CONSUMER_NAME.test(consumer)) return Promise.resolve(err(invalidConsumer()));
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE public.n2f_mailbox_receipts
            SET state='pending',attempts=0,available_at=clock_timestamp(),
                last_error=NULL,finished_at=NULL
          WHERE consumer=$1 AND state='dead' AND ($2::uuid IS NULL OR event_id=$2::uuid)`,
        [consumer, eventId ?? null],
      );
      return ok(result.rowCount ?? 0);
    });
  }

  async backlog(signal?: AbortSignal): Promise<Result<readonly InboxBacklog[], Failure>> {
    return this.database.transaction(async (transaction) => {
      const rows = (
        await transaction.query<{ consumer: string; state: 'pending' | 'dead'; count: string }>(
          `SELECT consumer,state,count(*) AS count
             FROM public.n2f_mailbox_receipts
            WHERE state IN ('pending','dead')
            GROUP BY consumer,state`,
        )
      ).rows;
      return ok(rows.map((row) => ({ consumer: row.consumer, state: row.state, count: Number(row.count) })));
    }, signal);
  }

  /**
   * Delete up to `limit` inbox events whose every receipt was processed more
   * than `retentionMs` ago. Dead receipts keep their event for requeueing.
   */
  prune(retentionMs: number, limit = 1000): Promise<Result<number, Failure>> {
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query(
        `DELETE FROM public.n2f_mailbox WHERE event_id IN (
           SELECT m.event_id FROM public.n2f_mailbox m
            WHERE NOT EXISTS (
              SELECT 1 FROM public.n2f_mailbox_receipts r
               WHERE r.event_id=m.event_id
                 AND (r.state<>'processed'
                      OR r.finished_at>=clock_timestamp()-($1::bigint*interval '1 millisecond')))
            LIMIT $2)`,
        [retentionMs, limit],
      );
      return ok(result.rowCount ?? 0);
    });
  }
}

function invalidConsumer(): Failure {
  return failure('invalid', 'invalid event consumer', { type: 'events.invalid_consumer' });
}
