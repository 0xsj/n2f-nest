import { Module } from '@nestjs/common';
import { DEFAULT_RETRY, InMemoryInbox } from '../../shared/events/index.js';
import { Mailbox } from '../../shared/events/postgres/index.js';
import type { Database } from '../../shared/postgres/index.js';
import type { RuntimeConfig } from '../runtime/config.js';
import { usesPostgres } from '../runtime/storage.js';
import { DATABASE, RUNTIME_CONFIG } from '../runtime/tokens.js';
import { EVENT_BUS } from './event-bus.js';
import { EVENT_INBOX, EVENT_RETRY_POLICY, EventDelivery } from './event-delivery.js';

/**
 * Event delivery for every module. The inbox follows the storage mode: the
 * PostgreSQL inbox (n2f_mailbox) survives restarts and is shared by every
 * process; the in-memory inbox keeps the same per-consumer semantics for
 * self-contained development.
 */
@Module({
  providers: [
    {
      provide: EVENT_INBOX,
      useFactory: (config: RuntimeConfig, database: Database | undefined) =>
        usesPostgres(config) && database ? new Mailbox(database) : new InMemoryInbox(),
      inject: [RUNTIME_CONFIG, DATABASE],
    },
    { provide: EVENT_RETRY_POLICY, useValue: DEFAULT_RETRY },
    EventDelivery,
    { provide: EVENT_BUS, useExisting: EventDelivery },
  ],
  exports: [EventDelivery, EVENT_BUS, EVENT_INBOX],
})
export class PlatformEventsModule {}
