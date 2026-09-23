import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RecordAuditEvent } from '../src/modules/audit/app/index.js';
import { PostgresAuditEntryWriter } from '../src/modules/audit/infra/postgres/index.js';
import { Broker } from '../src/shared/events/nats/index.js';
import {
  Envelope,
  type Publisher,
} from '../src/shared/events/index.js';
import {
  Database,
  type Config as DatabaseConfig,
} from '../src/shared/postgres/index.js';
import { SystemClock } from '../src/shared/clock/index.js';
import { parse, type ID, type IDGenerator } from '../src/shared/id/index.js';
import {
  anonymous,
  attribution,
  operation,
  restoreWork,
} from '../src/shared/provenance/index.js';
import { err, failure, ok } from '../src/shared/errors/index.js';
import { SecretString } from '../src/shared/secret/index.js';

const enabled = process.env.N2F_RUN_AUDIT_REDELIVERY === '1';
const integration = enabled ? describe : describe.skip;

function identifier(): ID {
  const value = parse(randomUUID());
  if (!value.ok) throw new Error('audit fixture generated an invalid ID');
  return value.value;
}

function fixture(): Envelope {
  const eventId = identifier();
  const work = restoreWork({
    workId: identifier(),
    correlationId: eventId,
    correlationSource: 'local',
    operation: operation('audit.redelivery').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'message',
  });
  if (!work.ok) throw new Error(work.error.message);

  const event = Envelope.create(
    eventId,
    'audit.redelivery.v1',
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

async function eventually<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();

  while (!ready(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }

  expect(ready(value)).toBe(true);
  return value;
}

integration('durable audit redelivery', () => {
  it('keeps one audit row when delivery fails after projection', async () => {
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

    const broker = await Broker.open({
      url: new SecretString(natsUrl),
      stream: process.env.N2F_NATS_STREAM ?? 'n2f_events',
      subjectPrefix: process.env.N2F_NATS_SUBJECT_PREFIX ?? 'n2f.events.',
      consumer: `audit_replay_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      consumerDeliverPolicy: 'new',
      timeoutMs: 2000,
    });
    expect(broker.ok).toBe(true);
    if (!broker.ok) {
      await database.close(5000);
      return;
    }

    const event = fixture();
    const writer = new PostgresAuditEntryWriter(database);
    const clock = new SystemClock();
    const record = new RecordAuditEvent({ clock, ids, writer });
    let attempts = 0;

    const sink: Publisher = {
      async publish(candidate) {
        const projected = await record.execute({ event: candidate });
        if (!projected.ok) return projected;

        attempts += 1;
        if (attempts === 1) {
          return err(
            failure('timeout', 'consumer acknowledgement was lost', {
              type: 'test.audit_ack_timeout',
            }),
          );
        }
        return ok({ eventId: candidate.id, durable: true });
      },
    };

    try {
      expect((await broker.value.provision()).ok).toBe(true);
      expect((await broker.value.publish(event)).ok).toBe(true);

      const first = await broker.value.transfer(sink);
      expect(first.ok).toBe(false);

      const second = await eventually(
        () => broker.value.transfer(sink),
        (result) => result.ok && result.value,
      );
      expect(second).toEqual({ ok: true, value: true });
      expect(attempts).toBe(2);

      const persisted = await database.transaction(async (transaction) => {
        const result = await transaction.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM public.n2f_audit_entries WHERE event_id=$1::uuid',
          [event.id],
        );
        return { ok: true, value: result.rows[0]?.count } as const;
      });
      expect(persisted).toEqual({ ok: true, value: '1' });
    } finally {
      await database.transaction(async (transaction) => {
        await transaction.query(
          'DELETE FROM public.n2f_audit_entries WHERE event_id=$1::uuid',
          [event.id],
        );
        return { ok: true, value: undefined } as const;
      });
      await broker.value.removeConsumer();
      await broker.value.close();
      await database.close(5000);
    }
  }, 20000);
});
