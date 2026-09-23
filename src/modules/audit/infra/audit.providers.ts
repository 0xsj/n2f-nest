import type { Provider } from '@nestjs/common';
import { SystemClock } from '../../../shared/clock/index.js';
import { V7 } from '../../../shared/id/index.js';
import type { Database } from '../../../shared/postgres/index.js';
import {
  DATABASE,
  requireDatabase,
  RUNTIME_CONFIG,
  type RuntimeConfig,
  usesPostgres,
} from '../../../platform/runtime/index.js';
import {
  ListAuditEntries,
  ListOrganizationAuditEntries,
  type AuditOrganizationAccessReader,
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

import { AUDIT_REQUIRES } from './requires.js';

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
      usesPostgres(config)
        ? new PostgresAuditEntryWriter(requireDatabase(database, 'Audit'))
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
      usesPostgres(config)
        ? new PostgresAuditEntryReader(requireDatabase(database, 'Audit'))
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
    provide: ListOrganizationAuditEntries,
    useFactory: (access: AuditOrganizationAccessReader, entries: AuditEntryReader) =>
      new ListOrganizationAuditEntries({ access, entries }),
    inject: [AUDIT_REQUIRES.organizationAccess, PORTS.reader],
  },
  {
    provide: ListAuditEntries,
    useFactory: (reader: AuditEntryReader) => new ListAuditEntries({ reader }),
    inject: [PORTS.reader],
  },
];
