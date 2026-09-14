import { loadConfig } from './config.js';
import { logging } from './logging.js';
import { Reader, type Lookup } from '../shared/env/index.js';
import { SystemClock } from '../shared/clock/index.js';
import { V7 } from '../shared/id/index.js';
import { Database } from '../shared/postgres/index.js';
import { Envelope } from '../shared/events/index.js';
import {
  Broker,
  type Config as BrokerConfig,
} from '../shared/events/jetstream/broker.js';
import {
  Store,
  Mailbox,
  migration,
  receiptsMigration,
  enqueue,
} from '../shared/events/postgres/store.js';
import {
  Factory,
  actor,
  operation,
  attribution,
  inspectIncoming,
} from '../shared/provenance/index.js';
import {
  AppError,
  ok,
  failure,
  fromCaught,
  type Result,
  type Failure,
} from '../shared/errors/index.js';
function value<T>(r: Result<T, Failure>): T {
  if (!r.ok) throw new AppError(r.error);
  return r.value;
}
/** Finite diagnostic delivery, with explicit resource ownership and no business effects. */
export async function runEvents(
  lookup: Lookup,
  signal?: AbortSignal,
): Promise<number> {
  const c = value(loadConfig(lookup)),
    r = new Reader(lookup);
  const config = {
    url: r.secret('DATABASE_URL'),
    maxConnections: r.int('DATABASE_MAX_CONNECTIONS', 8, 1, 64),
    timeoutMs: r.int('DATABASE_TIMEOUT_MS', 1000, 1, 30000),
  };
  const transport = r.string('EVENTS_TRANSPORT', 'postgres');
  let brokerConfig: BrokerConfig | undefined;
  if (transport === 'jetstream')
    brokerConfig = {
      url: r.secret('NATS_URL'),
      stream: r.string('NATS_STREAM', 'N2F_EVENTS'),
      consumer: r.string('NATS_CONSUMER', 'mailbox'),
      timeoutMs: r.int('NATS_TIMEOUT_MS', 1000, 1, 5000),
    };
  value(r.check());
  if (!['postgres', 'jetstream'].includes(transport)) return 2;
  const clock = new SystemClock(),
    ids = new V7(clock);
  c.resource = { ...c.resource, instance_id: value(ids.newId()) };
  const log = value(
    logging(
      c,
      clock,
      {
        write: (line) =>
          new Promise<void>((resolve, reject) =>
            process.stdout.write(line, (e) => (e ? reject(e) : resolve())),
          ),
      },
      false,
    ),
  );
  let database: Database | undefined;
  let broker: Broker | undefined;
  try {
    if (brokerConfig) {
      broker = value(await Broker.open(brokerConfig));
      value(await broker.provision(signal));
    }
    database = value(await Database.open(config));
    value(await database.migrate([migration(1), receiptsMigration(3)]));
    const factory = new Factory(clock, ids),
      executor = value(actor('service', c.resource.name));
    const scope = value(
      factory.enter(
        {
          origin: 'startup',
          operation: value(operation('events.example')),
          executor,
          attribution: value(attribution()),
        },
        inspectIncoming({}),
      ),
    );
    const scoped = value(log.log.withScope(scope));
    const eventId = value(ids.newId());
    const event = value(
      Envelope.create(
        eventId,
        'diagnostic.created.v1',
        clock.now().getTime(),
        scope.workContext(),
        { example: true },
      ),
    );
    value(await database.transaction((tx) => enqueue(tx, event), signal));
    scoped.info('events.enqueued', { event_id: eventId });
    const store = new Store(database),
      mailbox = new Mailbox(database);
    const publisher = broker ?? mailbox;
    scoped.info('events.transport.selected', { transport });
    const deadline = performance.now() + 10000;
    for (let i = 0; i < 32 && performance.now() < deadline; i++) {
      if (signal?.aborted)
        throw new AppError(failure('canceled', 'event example canceled'));
      const found = value(
        await store.dispatch(publisher, value(ids.newId()), signal),
      );
      scoped.info('events.dispatch.completed', { found });
      if (broker)
        scoped.info('events.transfer.completed', {
          found: value(await broker.transfer(mailbox, signal)),
        });
      let seen = false;
      const consumed = value(
        await mailbox.consume('events-example', async (_tx, received) => {
          seen = received.id === eventId;
          return ok(undefined);
        }),
      );
      scoped.info('events.consume.completed', { found: consumed });
      if (seen) {
        scoped.info('events.example.completed', { event_id: eventId });
        return 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new AppError(
      failure('timeout', 'diagnostic delivery budget exhausted'),
    );
  } catch (e) {
    log.log.withError(fromCaught(e)).error('events.example.failed');
    return 1;
  } finally {
    await broker?.close();
    await database?.close(2000);
    await log.close(2000);
  }
}
