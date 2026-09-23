import {
  Global,
  Inject,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  Injectable,
} from '@nestjs/common';
import { Database } from '../../shared/postgres/index.js';
import { SystemClock } from '../../shared/clock/index.js';
import { V7 } from '../../shared/id/index.js';
import { PlatformEventsModule } from '../events/events.module.js';
import { EVENT_BUS, type EventBus } from '../events/event-bus.js';
import { Broker } from '../../shared/events/nats/index.js';
import type { Publisher } from '../../shared/events/index.js';
import { OutboxDispatcher } from '../events/outbox-dispatcher.js';
import type { LegacyHistory, Migration } from '../../shared/postgres/index.js';
import { describeConfigFailure, loadRuntimeConfig, type RuntimeConfig } from './config.js';
import {
  DATABASE,
  DURABLE_EVENT_PUBLISHER,
  EVENT_OUTBOX,
  OUTBOX_DISPATCHER,
  NATS_BROKER,
  RUNTIME_CONFIG,
} from './tokens.js';
import { OutboxWorker } from './outbox-worker.js';
import { NatsEventWorker } from './nats-event-worker.js';
import { EventMaintenance } from './event-maintenance.js';
import { Store as PostgresEventStore } from '../../shared/events/postgres/index.js';
import { usesPostgres } from './storage.js';

function brokerOrThrow(broker: Broker | undefined): Broker {
  if (!broker) throw new Error('NATS broker was not initialized');
  return broker;
}

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly database: Database | undefined,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.database) await this.database.close(5000);
  }
}

@Global()
@Module({})
export class PlatformRuntimeModule {
  static forRoot(migrations: readonly Migration[], legacy?: LegacyHistory): DynamicModule {
    return {
      module: PlatformRuntimeModule,
      imports: [PlatformEventsModule],
      providers: [
        {
          provide: RUNTIME_CONFIG,
          useFactory: (): RuntimeConfig => {
            const result = loadRuntimeConfig();
            if (!result.ok) throw new Error(describeConfigFailure(result.error));
            return result.value;
          },
        },
        {
          provide: DATABASE,
          useFactory: async (config: RuntimeConfig): Promise<Database | undefined> => {
            if (!usesPostgres(config) || !config.database) {
              return undefined;
            }
            const opened = await Database.open(config.database);
            if (!opened.ok) throw new Error(opened.error.message);
            const migrated = await opened.value.migrate(
              migrations,
              config.database.migrationTimeoutMs,
              legacy,
            );
            if (!migrated.ok) {
              await opened.value.close(config.database.timeoutMs);
              throw new Error(migrated.error.message);
            }
            return opened.value;
          },
          inject: [RUNTIME_CONFIG],
        },
        {
          provide: NATS_BROKER,
          useFactory: async (config: RuntimeConfig): Promise<Broker | undefined> => {
            if (config.eventTransport !== 'nats' || !config.nats) {
              return undefined;
            }

            const opened = await Broker.open(config.nats);
            if (!opened.ok) throw new Error(opened.error.message);

            const provisioned = await opened.value.provision();
            if (!provisioned.ok) {
              await opened.value.close();
              throw new Error(provisioned.error.message);
            }

            return opened.value;
          },
          inject: [RUNTIME_CONFIG],
        },
        SystemClock,
        {
          provide: V7,
          useFactory: (clock: SystemClock) => new V7(clock),
          inject: [SystemClock],
        },
        {
          provide: EVENT_OUTBOX,
          useFactory: (database: Database | undefined) =>
            database ? new PostgresEventStore(database) : undefined,
          inject: [DATABASE],
        },
        {
          provide: DURABLE_EVENT_PUBLISHER,
          // Local transport: the outbox hands committed events straight to
          // the PostgreSQL inbox. NATS transport: the outbox publishes to
          // JetStream and NatsEventWorker hands deliveries to the inbox.
          useFactory: (
            config: RuntimeConfig,
            broker: Broker | undefined,
            bus: EventBus,
          ) =>
            config.eventTransport === 'nats' ? brokerOrThrow(broker) : bus,
          inject: [RUNTIME_CONFIG, NATS_BROKER, EVENT_BUS],
        },
        {
          provide: OUTBOX_DISPATCHER,
          useFactory: (
            config: RuntimeConfig,
            store: PostgresEventStore | undefined,
            publisher: Publisher,
            ids: V7,
          ) =>
            usesPostgres(config) && store
              ? new OutboxDispatcher(store, publisher, ids)
              : undefined,
          inject: [
            RUNTIME_CONFIG,
            EVENT_OUTBOX,
            DURABLE_EVENT_PUBLISHER,
            V7,
          ],
        },
        OutboxWorker,
        NatsEventWorker,
        EventMaintenance,
        DatabaseLifecycle,
      ],
      exports: [RUNTIME_CONFIG, DATABASE, NATS_BROKER],
    };
  }
}
