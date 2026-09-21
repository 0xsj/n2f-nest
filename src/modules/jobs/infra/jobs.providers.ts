import type { Provider } from '@nestjs/common';
import { SystemClock } from '../../../shared/clock/index.js';
import { V7 } from '../../../shared/id/index.js';
import type { Database } from '../../../shared/postgres/index.js';
import { Factory as ProvenanceFactory } from '../../../shared/provenance/index.js';
import {
  DATABASE,
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../../../platform/runtime/index.js';
import {
  CancelJob,
  CompleteJob,
  FailJob,
  ListJobs,
  RetryJob,
  StartJob,
  SubmitJob,
  SubmitWorkflowJob,
  type JobOrganizationAccessReader,
  type JobReader,
  type JobWriter,
} from '../app/index.js';
import {
  InMemoryJobReader,
  InMemoryJobStore,
  InMemoryJobWriter,
  OrganizationAccessReaderAdapter,
} from './in-memory/index.js';
import { PostgresJobReader, PostgresJobWriter } from './postgres/index.js';

const PORTS = {
  access: Symbol('jobs.organizationAccessReader'),
  reader: Symbol('jobs.reader'),
  writer: Symbol('jobs.writer'),
} as const;

function databaseOrThrow(database: Database | undefined): Database {
  if (!database) throw new Error('PostgreSQL Jobs storage was not initialized');
  return database;
}

export const jobsProviders: Provider[] = [
  SystemClock,
  {
    provide: V7,
    useFactory: (clock: SystemClock) => new V7(clock),
    inject: [SystemClock],
  },
  {
    provide: ProvenanceFactory,
    useFactory: (clock: SystemClock, ids: V7) => new ProvenanceFactory(clock, ids),
    inject: [SystemClock, V7],
  },
  InMemoryJobStore,
  InMemoryJobReader,
  InMemoryJobWriter,
  OrganizationAccessReaderAdapter,
  {
    provide: PORTS.access,
    useExisting: OrganizationAccessReaderAdapter,
  },
  {
    provide: PORTS.reader,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      inMemory: InMemoryJobReader,
    ): JobReader =>
      config.identityStorage === 'postgres'
        ? new PostgresJobReader(databaseOrThrow(database))
        : inMemory,
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryJobReader],
  },
  {
    provide: PORTS.writer,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      inMemory: InMemoryJobWriter,
    ): JobWriter =>
      config.identityStorage === 'postgres'
        ? new PostgresJobWriter(databaseOrThrow(database))
        : inMemory,
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryJobWriter],
  },
  {
    provide: SubmitJob,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      access: JobOrganizationAccessReader,
      writer: JobWriter,
    ) => new SubmitJob({ clock, ids, access, writer }),
    inject: [SystemClock, V7, PORTS.access, PORTS.writer],
  },
  {
    provide: StartJob,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      access: JobOrganizationAccessReader,
      jobs: JobReader,
      writer: JobWriter,
    ) => new StartJob({ clock, ids, access, jobs, writer }),
    inject: [SystemClock, V7, PORTS.access, PORTS.reader, PORTS.writer],
  },
  {
    provide: CompleteJob,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      access: JobOrganizationAccessReader,
      jobs: JobReader,
      writer: JobWriter,
    ) => new CompleteJob({ clock, ids, access, jobs, writer }),
    inject: [SystemClock, V7, PORTS.access, PORTS.reader, PORTS.writer],
  },
  {
    provide: FailJob,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      access: JobOrganizationAccessReader,
      jobs: JobReader,
      writer: JobWriter,
    ) => new FailJob({ clock, ids, access, jobs, writer }),
    inject: [SystemClock, V7, PORTS.access, PORTS.reader, PORTS.writer],
  },
  {
    provide: RetryJob,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      access: JobOrganizationAccessReader,
      jobs: JobReader,
      writer: JobWriter,
    ) => new RetryJob({ clock, ids, access, jobs, writer }),
    inject: [SystemClock, V7, PORTS.access, PORTS.reader, PORTS.writer],
  },
  {
    provide: CancelJob,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      access: JobOrganizationAccessReader,
      jobs: JobReader,
      writer: JobWriter,
    ) => new CancelJob({ clock, ids, access, jobs, writer }),
    inject: [SystemClock, V7, PORTS.access, PORTS.reader, PORTS.writer],
  },
  {
    provide: ListJobs,
    useFactory: (
      access: JobOrganizationAccessReader,
      jobs: JobReader,
    ) => new ListJobs({ access, jobs }),
    inject: [PORTS.access, PORTS.reader],
  },
  {
    provide: SubmitWorkflowJob,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      jobs: JobReader,
      writer: JobWriter,
    ) => new SubmitWorkflowJob({ clock, ids, jobs, writer }),
    inject: [SystemClock, V7, PORTS.reader, PORTS.writer],
  },
];
