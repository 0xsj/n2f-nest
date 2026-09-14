import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Broker } from './broker.js';
import { Envelope, type Publisher } from '../index.js';
import { Store, Mailbox, migration, receiptsMigration, enqueue } from '../postgres/store.js';
import { Database } from '../../postgres/index.js';
import { SecretString } from '../../secret/index.js';
import { parse } from '../../id/index.js';
import {
  ok,
  err,
  failure,
  type Result,
  type Failure,
} from '../../errors/index.js';
function value<T>(r: Result<T, Failure>): T {
  if (!r.ok) throw Error(r.error.type ?? r.error.kind);
  return r.value;
}
it.skipIf(!process.env.N2F_TEST_NATS_URL || !process.env.N2F_TEST_DATABASE_URL)(
  'real JetStream publisher seam and durable handoff',
  async () => {
    const db = value(
      await Database.open({
        url: new SecretString(process.env.N2F_TEST_DATABASE_URL!),
        maxConnections: 4,
        timeoutMs: 1000,
      }),
    );
    const broker = value(
      await Broker.open({
        url: new SecretString(process.env.N2F_TEST_NATS_URL!),
        stream: process.env.N2F_TEST_NATS_STREAM!,
        consumer: 'mailbox',
        timeoutMs: 1000,
      }),
    );
    try {
      value(
        await db.migrate([
          migration(1),
          {
            version: 2,
            sql: 'CREATE TABLE jetstream_effect(id uuid PRIMARY KEY)',
          },
          receiptsMigration(3),
        ]),
      );
      value(await broker.provision());
      value(await broker.provision());
      const event = value(
        Envelope.decode(
          readFileSync(new URL('../fixtures/envelope.json', import.meta.url)),
        ),
      );
      const a = value(parse('00000000-0000-4000-8000-000000000010')),
        b = value(parse('00000000-0000-4000-8000-000000000002'));
      const store = new Store(db),
        mailbox = new Mailbox(db);
      expect(
        (
          await db.transaction(async (tx) => {
            value(await enqueue(tx, event));
            return err(failure('conflict', 'fixture refusal'));
          })
        ).ok,
      ).toBe(false);
      expect(value(await store.dispatch(broker, a))).toBe(false);
      value(await db.transaction((tx) => enqueue(tx, event)));
      const lease = value(await store.claim(a))!;
      expect(value(await broker.publish(lease.event))).toEqual({
        eventId: event.id,
        durable: true,
      });
      value(
        await db.transaction(async (tx) => {
          await tx.query(
            "UPDATE n2f_outbox SET lease_until=clock_timestamp()-interval '1 second'",
          );
          return ok(undefined);
        }),
      );
      expect(value(await store.dispatch(broker, b))).toBe(true);
      const changed = value(
        Envelope.create(event.id, 'diagnostic.created.v1', 1000, event.work, {
          changed: true,
        }),
      );
      const reused = await broker.publish(changed);
      expect(reused.ok).toBe(false);
      if (!reused.ok) expect(reused.error.kind).toBe('conflict');
      const wrong: Publisher = {
        publish: async (e) => ok({ eventId: e.id, durable: false }),
      };
      expect((await broker.transfer(wrong)).ok).toBe(false);
      await new Promise((r) => setTimeout(r, 1100));
      expect(value(await broker.transfer(mailbox))).toBe(true);
      let calls = 0;
      expect(
        value(
          await mailbox.consume('jetstream', async (tx, e) => {
            calls++;
            await tx.query('INSERT INTO jetstream_effect VALUES($1)', [e.id]);
            return ok(undefined);
          }),
        ),
      ).toBe(true);
      value(await mailbox.publish(event));
      expect(
        value(
          await mailbox.consume('jetstream', async () => {
            calls++;
            return ok(undefined);
          }),
        ),
      ).toBe(false);
      expect(calls).toBe(1);
      expect(value(await broker.transfer(mailbox))).toBe(false);
      const base = value(
        Envelope.create(a, 'diagnostic.large.v1', 1000, event.work, {
          value: '',
        }),
      );
      const large = value(
        Envelope.create(a, 'diagnostic.large.v1', 1000, event.work, {
          value: 'x'.repeat(65536 - base.bytes().length),
        }),
      );
      expect(large.bytes().length).toBe(65536);
      value(await broker.publish(large));
      expect(value(await broker.transfer(mailbox))).toBe(true);
      expect(value(await mailbox.consume('jetstream', async () => ok(undefined)))).toBe(
        true,
      );
      value(await db.transaction((tx) => enqueue(tx, large)));
      await broker.close();
      expect((await store.dispatch(broker, b)).ok).toBe(false);
      expect(
        value(
          await db.transaction(async (tx) =>
            ok(
              (
                await tx.query(
                  'SELECT state FROM n2f_outbox WHERE event_id=$1',
                  [a],
                )
              ).rows[0].state,
            ),
          ),
        ),
      ).toBe('pending');
      expect((await broker.publish(event)).ok).toBe(false);
    } finally {
      await broker.close();
      await db.close(1000);
    }
  },
  15000,
);
