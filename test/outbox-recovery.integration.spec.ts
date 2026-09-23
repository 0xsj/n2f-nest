import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ChaosPublisher, FaultInjector } from '../src/platform/chaos/index.js';
import { OutboxDispatcher } from '../src/platform/events/outbox-dispatcher.js';
import { Broker } from '../src/shared/events/nats/index.js';
import {
  Envelope,
  type Publisher,
  type Receipt,
} from '../src/shared/events/index.js';
import {
  enqueue,
  Store as PostgresEventStore,
} from '../src/shared/events/postgres/index.js';
import {
  Database,
  type Config as DatabaseConfig,
} from '../src/shared/postgres/index.js';
import { parse, type ID, type IDGenerator } from '../src/shared/id/index.js';
import { SecretString } from '../src/shared/secret/index.js';
import {
  anonymous,
  attribution,
  operation,
  restoreWork,
} from '../src/shared/provenance/index.js';

const enabled = process.env.N2F_RUN_RECOVERY_INTEGRATION === '1';
const integration = enabled ? describe : describe.skip;

function identifier(): ID {
  const value = parse(randomUUID());
  if (!value.ok) throw new Error('recovery fixture generated an invalid ID');
  return value.value;
}

function fixture(): Envelope {
  const work = restoreWork({
    workId: identifier(),
    correlationId: identifier(),
    correlationSource: 'local',
    operation: operation('events.outbox.recovery').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'message',
  });
  if (!work.ok) throw new Error(work.error.message);

  const event = Envelope.create(
    identifier(),
    'events.outbox.recovery.v1',
    Date.now(),
    work.value,
    { identity_id: identifier() },
  );
  if (!event.ok) throw new Error(event.error.message);
  return event.value;
}

const ids: IDGenerator = {
  newId: () => ({ ok: true, value: identifier() }),
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function eventually<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();

  while (!ready(value) && Date.now() < deadline) {
    await delay(50);
    value = await read();
  }

  expect(ready(value)).toBe(true);
  return value;
}

integration('PostgreSQL outbox recovery', () => {
  it('releases an uncertain publish and delivers one JetStream message', async () => {
    const databaseUrl = process.env.N2F_DATABASE_URL;
    const natsUrl = process.env.N2F_NATS_URL;
    if (!databaseUrl || !natsUrl) {
      throw new Error('N2F_DATABASE_URL and N2F_NATS_URL are required');
    }

    const databaseConfig: DatabaseConfig = {
      url: new SecretString(databaseUrl),
      maxConnections: 4,
      timeoutMs: 5000,
    };
    const openedDatabase = await Database.open(databaseConfig);
    expect(openedDatabase.ok).toBe(true);
    if (!openedDatabase.ok) return;
    const database = openedDatabase.value;

    const stream = process.env.N2F_NATS_STREAM ?? 'n2f_events';
    const subjectPrefix = process.env.N2F_NATS_SUBJECT_PREFIX ?? 'n2f.events.';
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const publisherConsumer = `recovery_pub_${suffix}`;
    const subscriberConsumer = `recovery_audit_${suffix}`;
    const brokerConfig = {
      url: new SecretString(natsUrl),
      stream,
      subjectPrefix,
      timeoutMs: 2000,
    } as const;

    const openedPublisher = await Broker.open({
      ...brokerConfig,
      consumer: publisherConsumer,
      consumerDeliverPolicy: 'new',
    });
    const openedSubscriber = await Broker.open({
      ...brokerConfig,
      consumer: subscriberConsumer,
      consumerDeliverPolicy: 'new',
    });
    expect(openedPublisher.ok).toBe(true);
    expect(openedSubscriber.ok).toBe(true);
    if (!openedPublisher.ok || !openedSubscriber.ok) {
      await database.close(5000);
      return;
    }

    const publisherBroker = openedPublisher.value;
    const subscriberBroker = openedSubscriber.value;
    const event = fixture();
    const store = new PostgresEventStore(database);
    const faults = new FaultInjector();
    faults.arm({
      point: 'publisher.publish.after',
      action: 'fail',
      failure: {
        kind: 'timeout',
        message: 'test publish acknowledgement was lost',
        type: 'chaos.publisher_ack_timeout',
      },
    });
    const publisher = new ChaosPublisher(publisherBroker, faults);
    const dispatcher = new OutboxDispatcher(store, publisher, ids);
    let captured: Envelope[] = [];

    try {
      expect((await publisherBroker.provision()).ok).toBe(true);
      expect((await subscriberBroker.provision()).ok).toBe(true);

      // Make the fixture the oldest due row so the dispatcher claims it, not
      // an unrelated row left pending in a shared development database.
      const queued = await database.transaction(async (transaction) => {
        const enqueued = await enqueue(transaction, event);
        if (!enqueued.ok) return enqueued;
        await transaction.query(
          "UPDATE public.n2f_outbox SET available_at=clock_timestamp()-interval '100 years' WHERE event_id=$1::uuid",
          [event.id],
        );
        return enqueued;
      });
      expect(queued.ok).toBe(true);

      const uncertain = await dispatcher.dispatchOnce();
      expect(uncertain.ok).toBe(false);

      const afterUncertain = await database.transaction(async (transaction) => {
        const result = await transaction.query<{ state: string; attempts: number }>(
          'SELECT state,attempts FROM public.n2f_outbox WHERE event_id=$1::uuid',
          [event.id],
        );
        return { ok: true, value: result.rows[0] } as const;
      });
      expect(afterUncertain.ok).toBe(true);
      if (afterUncertain.ok) {
        expect(afterUncertain.value).toEqual({ state: 'pending', attempts: 1 });
      }

      // The release scheduled a backoff. Skip it (keeping the fixture the
      // oldest due row) and poll until the retry dispatches.
      await database.transaction(async (transaction) => {
        await transaction.query(
          "UPDATE public.n2f_outbox SET available_at=clock_timestamp()-interval '100 years' WHERE event_id=$1::uuid",
          [event.id],
        );
        return { ok: true, value: undefined } as const;
      });
      const recovered = await eventually(
        () => dispatcher.dispatchOnce(),
        (result) => result.ok && result.value,
      );
      expect(recovered).toEqual({ ok: true, value: true });

      const afterRecovery = await database.transaction(async (transaction) => {
        const result = await transaction.query<{ state: string; attempts: number }>(
          'SELECT state,attempts FROM public.n2f_outbox WHERE event_id=$1::uuid',
          [event.id],
        );
        return { ok: true, value: result.rows[0] } as const;
      });
      expect(afterRecovery.ok).toBe(true);
      if (afterRecovery.ok) {
        expect(afterRecovery.value).toEqual({ state: 'sent', attempts: 2 });
      }

      const sink: Publisher = {
        async publish(candidate): Promise<{ ok: true; value: Receipt }> {
          captured = [...captured, candidate];
          return { ok: true, value: { eventId: candidate.id, durable: true } };
        },
      };
      const delivered = await eventually(
        () => subscriberBroker.transfer(sink),
        (result) => result.ok && result.value,
      );
      expect(delivered).toEqual({ ok: true, value: true });
      expect(captured.map((candidate) => candidate.id)).toEqual([event.id]);
      expect((await subscriberBroker.transfer(sink)).value).toBe(false);
    } finally {
      await database.transaction(async (transaction) => {
        await transaction.query(
          'DELETE FROM public.n2f_outbox WHERE event_id=$1::uuid',
          [event.id],
        );
        return { ok: true, value: undefined } as const;
      });
      await publisherBroker.removeConsumer();
      await subscriberBroker.removeConsumer();
      await publisherBroker.close();
      await subscriberBroker.close();
      await database.close(5000);
    }
  }, 20000);
});
