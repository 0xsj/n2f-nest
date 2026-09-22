import type { Provider } from '@nestjs/common';
import { SystemClock } from '../../../shared/clock/index.js';
import { V7 } from '../../../shared/id/index.js';
import type { Database } from '../../../shared/postgres/index.js';
import { Factory as ProvenanceFactory } from '../../../shared/provenance/index.js';
import {
  DATABASE,
  requireDatabase,
  RUNTIME_CONFIG,
  type RuntimeConfig,
  usesPostgres,
} from '../../../platform/runtime/index.js';
import {
  ArchiveDocument,
  BeginDocumentProcessing,
  CompleteDocumentProcessing,
  CreateDocument,
  FailDocumentProcessing,
  GetDocument,
  ListDocuments,
  type DocumentReader,
  type DocumentWriter,
  type OrganizationAccessReader,
} from '../app/index.js';
import {
  InMemoryDocumentReader,
  InMemoryDocumentStore,
  InMemoryDocumentWriter,
  OrganizationAccessReaderAdapter,
} from './in-memory/index.js';
import {
  PostgresDocumentReader,
  PostgresDocumentWriter,
} from './postgres/index.js';

const PORTS = {
  access: Symbol('document.organizationAccessReader'),
  reader: Symbol('document.reader'),
  writer: Symbol('document.writer'),
} as const;

export const documentProviders: Provider[] = [
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
  InMemoryDocumentStore,
  InMemoryDocumentReader,
  InMemoryDocumentWriter,
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
      inMemory: InMemoryDocumentReader,
    ): DocumentReader =>
      usesPostgres(config)
        ? new PostgresDocumentReader(requireDatabase(database, 'Document'))
        : inMemory,
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryDocumentReader],
  },
  {
    provide: PORTS.writer,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      inMemory: InMemoryDocumentWriter,
    ): DocumentWriter =>
      usesPostgres(config)
        ? new PostgresDocumentWriter(requireDatabase(database, 'Document'))
        : inMemory,
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryDocumentWriter],
  },
  {
    provide: CreateDocument,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      access: OrganizationAccessReader,
      writer: DocumentWriter,
    ) => new CreateDocument({ clock, ids, access, writer }),
    inject: [SystemClock, V7, PORTS.access, PORTS.writer],
  },
  {
    provide: ArchiveDocument,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      access: OrganizationAccessReader,
      documents: DocumentReader,
      writer: DocumentWriter,
    ) => new ArchiveDocument({ clock, ids, access, documents, writer }),
    inject: [SystemClock, V7, PORTS.access, PORTS.reader, PORTS.writer],
  },
  {
    provide: ListDocuments,
    useFactory: (
      access: OrganizationAccessReader,
      documents: DocumentReader,
    ) => new ListDocuments({ access, documents }),
    inject: [PORTS.access, PORTS.reader],
  },
  {
    provide: GetDocument,
    useFactory: (
      access: OrganizationAccessReader,
      documents: DocumentReader,
    ) => new GetDocument({ access, documents }),
    inject: [PORTS.access, PORTS.reader],
  },
  {
    provide: BeginDocumentProcessing,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      documents: DocumentReader,
      writer: DocumentWriter,
    ) => new BeginDocumentProcessing({ clock, ids, documents, writer }),
    inject: [SystemClock, V7, PORTS.reader, PORTS.writer],
  },
  {
    provide: CompleteDocumentProcessing,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      documents: DocumentReader,
      writer: DocumentWriter,
    ) => new CompleteDocumentProcessing({ clock, ids, documents, writer }),
    inject: [SystemClock, V7, PORTS.reader, PORTS.writer],
  },
  {
    provide: FailDocumentProcessing,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      documents: DocumentReader,
      writer: DocumentWriter,
    ) => new FailDocumentProcessing({ clock, ids, documents, writer }),
    inject: [SystemClock, V7, PORTS.reader, PORTS.writer],
  },
];
