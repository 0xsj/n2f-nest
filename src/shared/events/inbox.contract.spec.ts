import { describe, expect, it } from 'vitest';
import {
  event,
  newId,
  postgresContract,
  value,
  work,
} from '../../../test/support/adapter-contract.js';
import { err, failure, ok, type Failure, type Result } from '../errors/index.js';
import { Envelope, InMemoryInbox, type Delivery, type Inbox, type RetryPolicy } from './index.js';
import { Mailbox, Store, enqueue } from './postgres/index.js';
import type { Database } from '../postgres/index.js';

/**
 * One behavioral contract for every event inbox, plus the PostgreSQL-only
 * quarantine and pruning paths. The PostgreSQL run uses its own database:
 * claims take "the next due row", which live workers of suites running in
 * parallel would otherwise take from, or leave to, these cases.
 */
const FAST: RetryPolicy = { maxAttempts: 3, baseMs: 1, maxMs: 4 };

function consumer(label: string): string {
  return `${label}_${newId().replace(/-/g, '').slice(-12)}`;
}

function fixture(): Envelope {
  return event('contract.inbox.v1', work('contract.inbox'), { id: newId() });
}

const succeed = async (): Promise<Result<void, Failure>> => ok(undefined);
const fail = async (): Promise<Result<void, Failure>> =>
  err(failure('unavailable', 'consumer unavailable', { type: 'contract.unavailable' }));

/** Deliver until the consumer has nothing due, waiting out backoff; return every delivery. */
async function drain(
  inbox: Inbox,
  name: string,
  handler: (event: Envelope) => Promise<Result<void, Failure>>,
  until: (deliveries: Delivery[]) => boolean,
): Promise<Delivery[]> {
  const deliveries: Delivery[] = [];
  const deadline = Date.now() + 5000;
  while (!until(deliveries) && Date.now() < deadline) {
    const delivered = value(await inbox.deliver(name, handler, FAST));
    if (delivered) deliveries.push(delivered);
    else await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return deliveries;
}

function contract(name: string, inbox: () => Inbox) {
  describe(`${name} inbox`, () => {
    it('delivers to each consumer independently; a failing consumer retries alone', async () => {
      const healthy = consumer('healthy');
      const flaky = consumer('flaky');
      const published = fixture();
      value(await inbox().accept(published, [healthy, flaky]));

      let flakyCalls = 0;
      const flakyThenFine = async () => (++flakyCalls === 1 ? fail() : succeed());
      let healthyCalls = 0;
      const countHealthy = async () => {
        healthyCalls += 1;
        return succeed();
      };

      const flakyDeliveries = await drain(inbox(), flaky, flakyThenFine, (d) =>
        d.some((delivery) => delivery.outcome === 'processed'),
      );
      const healthyDeliveries = await drain(inbox(), healthy, countHealthy, (d) => d.length === 1);

      expect(flakyDeliveries.map((delivery) => delivery.outcome)).toEqual([
        'retrying',
        'processed',
      ]);
      expect(healthyDeliveries).toEqual([
        expect.objectContaining({ eventId: published.id, outcome: 'processed', attempt: 1 }),
      ]);
      expect(healthyCalls).toBe(1);
      expect(value(await inbox().deliver(healthy, countHealthy, FAST))).toBeNull();
    });

    it('dead-letters after the retry budget and redelivers once requeued', async () => {
      const name = consumer('dead');
      const published = fixture();
      value(await inbox().accept(published, [name]));

      const failures = await drain(inbox(), name, fail, (d) =>
        d.some((delivery) => delivery.outcome === 'dead'),
      );
      expect(failures.map((delivery) => delivery.outcome)).toEqual([
        'retrying',
        'retrying',
        'dead',
      ]);
      expect(value(await inbox().deliver(name, succeed, FAST))).toBeNull();

      expect(value(await inbox().requeue(name, published.id))).toBe(1);
      const recovered = await drain(inbox(), name, succeed, (d) => d.length === 1);
      expect(recovered).toEqual([expect.objectContaining({ outcome: 'processed', attempt: 1 })]);
    });

    it('accepts the same event once and refuses a reused ID with other content', async () => {
      const name = consumer('idempotent');
      const published = fixture();
      value(await inbox().accept(published, [name]));
      value(await inbox().accept(published, [name]));
      const deliveries = await drain(inbox(), name, succeed, (d) => d.length === 1);
      expect(deliveries).toHaveLength(1);
      expect(value(await inbox().deliver(name, succeed, FAST))).toBeNull();

      const reused = value(
        Envelope.create(published.id, 'contract.other.v1', Date.now(), work('contract.inbox'), {}),
      );
      expect(await inbox().accept(reused, [name])).toMatchObject({
        ok: false,
        error: { type: 'events.id_reused' },
      });
    });
  });
}

const memory = new InMemoryInbox();
contract('in-memory', () => memory);

type Postgres = Readonly<{ inbox: Mailbox; outbox: Store; database: Database }>;

async function sql(database: Database, text: string, params: unknown[]): Promise<void> {
  value(
    await database.transaction(async (transaction) => {
      await transaction.query(text, params);
      return ok(undefined);
    }),
  );
}

postgresContract(
  (database): Postgres => ({
    inbox: new Mailbox(database),
    outbox: new Store(database, FAST),
    database,
  }),
  (postgres) => {
    contract('PostgreSQL', () => postgres().inbox);

    describe('PostgreSQL delivery hardening', () => {
      it('quarantines an undecodable inbox row and keeps delivering', async () => {
        const { inbox, database } = postgres();
        const name = consumer('poison');
        const poisonId = newId();
        await sql(database, `INSERT INTO public.n2f_mailbox(event_id,envelope) VALUES ($1::uuid,'{"broken":true}')`, [poisonId]);
        await sql(database, 'INSERT INTO public.n2f_mailbox_receipts(event_id,consumer) VALUES ($1::uuid,$2)', [poisonId, name]);
        const healthy = fixture();
        value(await inbox.accept(healthy, [name]));

        const deliveries = await drain(inbox, name, succeed, (d) => d.length === 2);

        expect(deliveries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ eventId: poisonId, outcome: 'dead', error: 'events.undecodable' }),
            expect.objectContaining({ eventId: healthy.id, outcome: 'processed' }),
          ]),
        );
        await sql(database, 'DELETE FROM public.n2f_mailbox WHERE event_id=$1::uuid', [poisonId]);
      });

      it('quarantines an undecodable outbox row instead of blocking the queue', async () => {
        const { outbox, database } = postgres();
        const poisonId = newId();
        await sql(database, `INSERT INTO public.n2f_outbox(event_id,envelope,available_at) VALUES ($1::uuid,'{"broken":true}',clock_timestamp()-interval '100 years')`, [poisonId]);

        const claimed = value(await outbox.claim(newId()));

        expect(claimed).toEqual({ quarantined: poisonId });
        const state = value(
          await database.transaction(async (transaction) =>
            ok(
              (
                await transaction.query<{ state: string; last_error: string }>(
                  'SELECT state,last_error FROM public.n2f_outbox WHERE event_id=$1::uuid',
                  [poisonId],
                )
              ).rows[0],
            ),
          ),
        );
        expect(state).toEqual({ state: 'dead', last_error: 'events.undecodable' });
        await sql(database, 'DELETE FROM public.n2f_outbox WHERE event_id=$1::uuid', [poisonId]);
      });

      it('retries a failed publish with backoff, then dead-letters and requeues it', async () => {
        const { outbox, database } = postgres();
        const published = fixture();
        value(await database.transaction((transaction) => enqueue(transaction, published)));
        // dispatch() claims the oldest due row. Keep this fixture the oldest
        // (skipping its backoff) so rows from other cases here are untouched.
        const makeOldest = () =>
          sql(
            database,
            "UPDATE public.n2f_outbox SET available_at=clock_timestamp()-interval '100 years' WHERE event_id=$1::uuid AND state='pending'",
            [published.id],
          );
        const refusing = {
          publish: async () =>
            err(failure('unavailable', 'broker unavailable', { type: 'contract.broker_down' })),
        };

        const deadline = Date.now() + 5000;
        let row: { state: string; attempts: number; last_error: string | null } | undefined;
        while (Date.now() < deadline) {
          await makeOldest();
          await outbox.dispatch(refusing, newId());
          row = value(
            await database.transaction(async (transaction) =>
              ok(
                (
                  await transaction.query<{ state: string; attempts: number; last_error: string | null }>(
                    'SELECT state,attempts,last_error FROM public.n2f_outbox WHERE event_id=$1::uuid',
                    [published.id],
                  )
                ).rows[0],
              ),
            ),
          );
          if (row?.state === 'dead') break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(row).toEqual({ state: 'dead', attempts: FAST.maxAttempts, last_error: 'contract.broker_down' });

        expect(value(await outbox.requeue(published.id))).toBe(1);
        const accepting = {
          publish: async (candidate: Envelope) => ok({ eventId: candidate.id, durable: true }),
        };
        await makeOldest();
        const sent = await (async () => {
          for (let attempt = 0; attempt < 50; attempt += 1) {
            const dispatched = value(await outbox.dispatch(accepting, newId()));
            if (dispatched) return dispatched;
          }
          return false;
        })();
        expect(sent).toBe(true);
      });

      it('prunes inbox events once every consumer has processed them', async () => {
        const { inbox, database } = postgres();
        const name = consumer('prune');
        const published = fixture();
        value(await inbox.accept(published, [name]));
        await drain(inbox, name, succeed, (d) => d.length === 1);

        const pruned = value(await inbox.prune(0, 100_000));

        expect(pruned).toBeGreaterThanOrEqual(1);
        const remaining = value(
          await database.transaction(async (transaction) =>
            ok(
              (
                await transaction.query('SELECT 1 FROM public.n2f_mailbox WHERE event_id=$1::uuid', [
                  published.id,
                ])
              ).rowCount,
            ),
          ),
        );
        expect(remaining).toBe(0);
      });
    });
  },
  { isolated: true },
);
