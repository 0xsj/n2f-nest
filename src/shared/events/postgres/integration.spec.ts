import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Envelope, type Publisher } from '../index.js';
import { Store, Mailbox, migration, receiptsMigration, enqueue } from './store.js';
import { Database } from '../../postgres/index.js';
import { SecretString } from '../../secret/index.js';
import { parse } from '../../id/index.js';
import {
  err,
  failure,
  ok,
  type Result,
  type Failure,
} from '../../errors/index.js';
function value<T>(r: Result<T, Failure>): T {
  if (!r.ok) throw Error(r.error.type ?? r.error.kind);
  return r.value;
}
const ident = (n: number) =>
  value(parse('00000000-0000-4000-8000-' + String(n).padStart(12, '0')));
const event = (n: number) => {
  const w = JSON.parse(
    readFileSync(new URL('../fixtures/envelope.json', import.meta.url), 'utf8'),
  );
  w.id = ident(n);
  return value(Envelope.decode(Buffer.from(JSON.stringify(w))));
};
it.skipIf(!process.env.N2F_TEST_DATABASE_URL)(
  'real outbox and mailbox guarantees',
  async () => {
    const db = value(
      await Database.open({
        url: new SecretString(process.env.N2F_TEST_DATABASE_URL!),
        maxConnections: 4,
        timeoutMs: 1000,
      }),
    );
    try {
      value(
        await db.migrate([
          migration(1),
          {
            version: 2,
            sql: 'CREATE TABLE event_fixture(id integer PRIMARY KEY)',
          },
          receiptsMigration(3),
        ]),
      );
      const exec = async (sql: string) =>
        value(
          await db.transaction(async (tx) => {
            await tx.query(sql);
            return ok(undefined);
          }),
        );
      const count = async (sql: string) =>
        Number(
          value(
            await db.transaction(async (tx) =>
              ok((await tx.query(sql)).rows[0].count),
            ),
          ),
        );
      const ready = () =>
        exec(
          'UPDATE n2f_outbox SET available_at=clock_timestamp(); UPDATE n2f_mailbox_receipts SET available_at=clock_timestamp()',
        );
      const add = async (e: Envelope) =>
        value(await db.transaction((tx) => enqueue(tx, e)));
      const refused = failure('conflict', 'fixture refusal');
      expect(
        (
          await db.transaction(async (tx) => {
            await tx.query('INSERT INTO event_fixture VALUES(1)');
            value(await enqueue(tx, event(1)));
            return err(refused);
          })
        ).ok,
      ).toBe(false);
      expect(await count('SELECT count(*) FROM n2f_outbox')).toBe(0);
      expect(await count('SELECT count(*) FROM event_fixture')).toBe(0);
      await add(event(1));
      const store = new Store(db),
        mailbox = new Mailbox(db);
      const offline: Publisher = {
        publish: async () => err(failure('unavailable', 'offline')),
      };
      const wrong: Publisher = {
        publish: async () => ok({ eventId: ident(999), durable: true }),
      };
      expect((await store.dispatch(offline, ident(100))).ok).toBe(false);
      await ready();
      expect((await store.dispatch(wrong, ident(101))).ok).toBe(false);
      await ready();
      expect(value(await store.dispatch(mailbox, ident(102)))).toBe(true);
      value(await mailbox.publish(event(1)));
      expect(await count('SELECT count(*) FROM n2f_mailbox')).toBe(1);
      const first = event(1);
      const changed = value(
        Envelope.create(first.id, 'diagnostic.created.v1', 1000, first.work, {
          different: true,
        }),
      );
      const reused = await mailbox.publish(changed);
      expect(reused.ok).toBe(false);
      if (!reused.ok) expect(reused.error.kind).toBe('conflict');
      expect(
        (
          await mailbox.consume('fixture', async (tx) => {
            await tx.query('INSERT INTO event_fixture VALUES(2)');
            return err(refused);
          })
        ).ok,
      ).toBe(false);
      expect(await count('SELECT count(*) FROM event_fixture')).toBe(0);
      await ready();
      expect(
        value(
          await mailbox.consume('fixture', async (tx) => {
            await tx.query('INSERT INTO event_fixture VALUES(2)');
            return ok(undefined);
          }),
        ),
      ).toBe(true);
      expect(await count('SELECT count(*) FROM event_fixture')).toBe(1);
      value(await mailbox.publish(event(1)));
      expect(
        value(
          await mailbox.consume('fixture', async () => {
            throw Error('duplicate consumed');
          }),
        ),
      ).toBe(false);
      expect(
        value(await mailbox.consume('other', async () => ok(undefined))),
      ).toBe(true);
      await add(event(2));
      const old = value(await store.claim(ident(200)))!;
      await exec(
        "UPDATE n2f_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE state='pending'",
      );
      const fresh = value(await store.claim(ident(201)))!;
      const stale = await store.ack(old);
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.type).toBe('events.lease_lost');
      value(await mailbox.publish(fresh.event));
      value(await store.ack(fresh));
      await add(event(3));
      for (let n = 0; n < 5; n++) {
        await ready();
        expect((await store.dispatch(offline, ident(300 + n))).ok).toBe(false);
      }
      expect(
        await count(
          "SELECT count(*) FROM n2f_outbox WHERE state='dead' AND attempts=5",
        ),
      ).toBe(1);
      for (let n = 0; n < 5; n++) {
        await ready();
        expect((await mailbox.consume('fixture', async () => err(refused))).ok).toBe(
          false,
        );
      }
      expect(
        await count(
          "SELECT count(*) FROM n2f_mailbox_receipts WHERE consumer='fixture' AND state='dead' AND attempts=5",
        ),
      ).toBe(1);
      await add(event(5));
      await add(event(6));
      const [a, b] = await Promise.all([
        store.claim(ident(500)),
        store.claim(ident(501)),
      ]);
      expect(value(a)!.event.id).not.toBe(value(b)!.event.id);
      // jsonb output spacing expands this valid wire beyond 64 KiB.
      await exec('TRUNCATE n2f_outbox, n2f_mailbox, n2f_mailbox_receipts');
      await add(
        value(
          Envelope.create(
            ident(700),
            'diagnostic.created.v1',
            1000,
            first.work,
            { values: Array(30000).fill(0) },
          ),
        ),
      );
      expect(value(await store.dispatch(mailbox, ident(701)))).toBe(true);
      expect(
        value(
          await mailbox.consume('fixture', async (_, got) => {
            expect(got.id).toBe(ident(700));
            return ok(undefined);
          }),
        ),
      ).toBe(true);
    } finally {
      await db.close(1000);
    }
  },
  15000,
);
