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

export const migration = (version: number): Migration => ({
  version,
  sql: readFileSync(
    new URL('./migrations/0001_events.sql', import.meta.url),
    'utf8',
  ),
});

export const receiptsMigration = (version: number): Migration => ({
  version,
  sql: readFileSync(
    new URL('./migrations/0003_mailbox_receipts.sql', import.meta.url),
    'utf8',
  ),
});

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

export class Store {
  constructor(readonly database: Database) {}

  async claim(token: ID): Promise<Result<Lease | undefined, Failure>> {
    const valid = parse(token);
    if (!valid.ok) return valid;
    return this.database.transaction(async (transaction) => {
      await transaction.query(
        "UPDATE public.n2f_outbox SET state='dead',lease=NULL,lease_until=NULL WHERE state='pending' AND attempts=5 AND (lease_until IS NULL OR lease_until<=clock_timestamp())",
      );
      const row = (
        await transaction.query<{ envelope: string; attempts: number }>(
          "WITH candidate AS (SELECT event_id FROM public.n2f_outbox WHERE state='pending' AND attempts<5 AND available_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY available_at,event_id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE public.n2f_outbox o SET lease=$1::uuid,lease_until=clock_timestamp()+interval '30 seconds',attempts=o.attempts+1 FROM candidate c WHERE o.event_id=c.event_id RETURNING o.envelope::text,o.attempts",
          [token],
        )
      ).rows[0];
      if (!row) return ok(undefined);
      const event = Envelope.decode(Buffer.from(row.envelope));
      return event.ok
        ? ok({ event: event.value, token, attempt: row.attempts })
        : event;
    });
  }

  ack(lease: Lease): Promise<Result<void, Failure>> {
    return this.finish(lease, true);
  }

  release(lease: Lease): Promise<Result<void, Failure>> {
    return this.finish(lease, false);
  }

  private finish(
    lease: Lease,
    success: boolean,
  ): Promise<Result<void, Failure>> {
    return this.database.transaction(async (transaction) => {
      const state = success
        ? "'sent'"
        : "CASE WHEN attempts>=5 THEN 'dead' ELSE 'pending' END";
      const result = await transaction.query(
        'UPDATE public.n2f_outbox SET state=' +
          state +
          ",lease=NULL,lease_until=NULL,available_at=clock_timestamp()+interval '100 milliseconds' WHERE event_id=$1::uuid AND lease=$2::uuid AND state='pending' AND lease_until>clock_timestamp()",
        [lease.event.id, lease.token],
      );
      return result.rowCount === 1
        ? ok(undefined)
        : err(conflict('lease_lost'));
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
    const released = await this.release(lease);
    if (!released.ok) return released;
    return receipt.ok
      ? err(
          failure('unavailable', 'publisher receipt invalid', {
            type: 'events.invalid_receipt',
          }),
        )
      : receipt;
  }
}

export class Mailbox implements Publisher {
  constructor(readonly database: Database) {}

  async publish(
    event: Envelope,
    signal?: AbortSignal,
  ): Promise<Result<Receipt, Failure>> {
    const result = await this.database.transaction(
      (transaction) => insert(transaction, 'mailbox', event),
      signal,
    );
    return result.ok ? ok({ eventId: event.id, durable: true }) : result;
  }

  async consume(
    consumer: string,
    fn: (
      transaction: pg.PoolClient,
      event: Envelope,
      signal: AbortSignal,
    ) => Promise<Result<void, Failure>>,
  ): Promise<Result<boolean, Failure>> {
    if (!/^[a-z0-9_.-]{1,64}$/.test(consumer)) {
      return err(
        failure('invalid', 'invalid event consumer', {
          type: 'events.invalid_consumer',
        }),
      );
    }

    let rejected: Failure | undefined;
    const result = await this.database.transaction(async (transaction, signal) => {
      await transaction.query(
        'INSERT INTO public.n2f_mailbox_receipts(event_id,consumer) SELECT event_id,$1 FROM public.n2f_mailbox ON CONFLICT(event_id,consumer) DO NOTHING',
        [consumer],
      );
      const row = (
        await transaction.query<{ envelope: string; attempts: number }>(
          "SELECT m.envelope::text,r.attempts FROM public.n2f_mailbox m JOIN public.n2f_mailbox_receipts r ON r.event_id=m.event_id WHERE r.consumer=$1 AND r.state='pending' AND r.attempts<5 AND r.available_at<=clock_timestamp() ORDER BY r.available_at,m.event_id FOR UPDATE OF m,r SKIP LOCKED LIMIT 1",
          [consumer],
        )
      ).rows[0];
      if (!row) return ok(false);

      const event = Envelope.decode(Buffer.from(row.envelope));
      if (!event.ok) return event;
      await transaction.query('SAVEPOINT n2f_consumer');
      try {
        const handled = await fn(transaction, event.value, signal);
        if (!handled.ok) {
          rejected = handled.error;
          await transaction.query('ROLLBACK TO SAVEPOINT n2f_consumer');
        }
      } catch (error) {
        rejected = map(error);
        await transaction.query('ROLLBACK TO SAVEPOINT n2f_consumer');
      }
      await transaction.query('RELEASE SAVEPOINT n2f_consumer');
      const state = !rejected
        ? 'processed'
        : row.attempts + 1 >= 5
          ? 'dead'
          : 'pending';
      await transaction.query(
        "UPDATE public.n2f_mailbox_receipts SET state=$3,attempts=attempts+1,available_at=clock_timestamp()+interval '100 milliseconds' WHERE event_id=$1::uuid AND consumer=$2",
        [event.value.id, consumer, state],
      );
      return ok(true);
    });
    return result.ok && rejected ? err(rejected) : result;
  }
}
