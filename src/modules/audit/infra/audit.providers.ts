import type { Provider } from '@nestjs/common';
import { SystemClock } from '../../../shared/clock/index.js';
import { V7 } from '../../../shared/id/index.js';
import type { Database } from '../../../shared/postgres/index.js';
import {
  DATABASE,
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../../../platform/runtime/index.js';
import {
  ListAuditEntries,
  RecordAuditEvent,
} from '../app/index.js';
import type {
  AuditEntryReader,
  AuditEntryWriter,
} from '../app/index.js';
import {
  InMemoryAuditEntryReader,
  InMemoryAuditEntryWriter,
  InMemoryAuditStore,
} from './in-memory/index.js';
import {
  PostgresAuditEntryReader,
  PostgresAuditEntryWriter,
} from './postgres/index.js';

const PORTS = {
  reader: Symbol('audit.entryReader'),
  writer: Symbol('audit.entryWriter'),
} as const;

export const auditProviders: Provider[] = [
  InMemoryAuditStore,
  SystemClock,
  {
    provide: V7,
    useFactory: (clock: SystemClock) => new V7(clock),
    inject: [SystemClock],
  },
  {
    provide: PORTS.writer,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      store: InMemoryAuditStore,
    ) =>
      config.identityStorage === 'postgres'
        ? new PostgresAuditEntryWriter(databaseOrThrow(database))
        : new InMemoryAuditEntryWriter(store),
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryAuditStore],
  },
  {
    provide: PORTS.reader,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      store: InMemoryAuditStore,
    ) =>
      config.identityStorage === 'postgres'
        ? new PostgresAuditEntryReader(databaseOrThrow(database))
        : new InMemoryAuditEntryReader(store),
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryAuditStore],
  },
  {
    provide: RecordAuditEvent,
    useFactory: (clock: SystemClock, ids: V7, writer: AuditEntryWriter) =>
      new RecordAuditEvent({ clock, ids, writer }),
    inject: [SystemClock, V7, PORTS.writer],
  },
  {
    provide: ListAuditEntries,
    useFactory: (reader: AuditEntryReader) => new ListAuditEntries({ reader }),
    inject: [PORTS.reader],
  },
];

function databaseOrThrow(database: Database | undefined): Database {
  if (!database) {
    throw new Error('PostgreSQL Audit storage was not initialized');
  }
  return database;
}
