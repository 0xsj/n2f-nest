import {
  err,
  failure,
  ok,
  type Result,
} from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import type { WallClock } from '../../../../shared/clock/index.js';
import type { ID, IDGenerator } from '../../../../shared/id/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import { DOCUMENT_EVENT_TYPES, Document } from '../../domain/index.js';
import type {
  DocumentWriter,
  OrganizationAccessReader,
} from '../ports/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type DocumentApplicationFailure,
} from '../failures.js';

export type CreateDocumentCommand = Readonly<{
  sessionToken: SecretString;
  organizationId: ID;
  name: unknown;
  storageKey?: unknown;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type CreateDocumentDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  access: OrganizationAccessReader;
  writer: DocumentWriter;
}>;

export type CreateDocumentResult = Readonly<{
  documentId: ID;
  organizationId: ID;
  name: string;
  storageKey: string | null;
  status: 'active';
}>;

function nextId(ids: IDGenerator): Result<ID, DocumentApplicationFailure> {
  const generated = ids.newId();
  return generated.ok
    ? generated
    : err(idGenerationFailure(generated.error));
}

export class CreateDocument {
  constructor(private readonly dependencies: CreateDocumentDependencies) {}

  async execute(
    command: CreateDocumentCommand,
  ): Promise<Result<CreateDocumentResult, DocumentApplicationFailure>> {
    if (command.work.snapshot().operation !== 'document.create') {
      return err(
        failure('invalid', 'document creation operation is invalid', {
          type: 'document.invalid_operation',
        }),
      );
    }

    const access = await this.dependencies.access.find(
      command.sessionToken,
      command.organizationId,
      command.signal,
    );
    if (!access.ok) return err(dependencyFailure(access.error, 'organization.access.find'));
    if (access.value === null) {
      return err(
        failure('forbidden', 'organization access is required', {
          type: 'document.access_forbidden',
        }),
      );
    }

    const createdAt = this.dependencies.clock.now();
    const documentId = nextId(this.dependencies.ids);
    if (!documentId.ok) return documentId;

    const document = Document.create({
      id: documentId.value,
      organizationId: command.organizationId,
      name: command.name,
      storageKey: command.storageKey,
      createdAt,
    });
    if (!document.ok) return document;

    const eventId = nextId(this.dependencies.ids);
    if (!eventId.ok) return eventId;
    const event = Envelope.create(
      eventId.value,
      DOCUMENT_EVENT_TYPES.created,
      createdAt.getTime(),
      command.work,
      {
        organization_id: document.value.organizationId,
        document_id: document.value.id,
        identity_id: access.value.identityId,
        name: document.value.name,
        storage_key: document.value.storageKey,
        status: document.value.status,
      },
    );
    if (!event.ok) return err(dependencyFailure(event.error, 'event.create'));

    const committed = await this.dependencies.writer.commit({
      mode: 'create',
      document: document.value,
      event: event.value,
      work: command.work,
      signal: command.signal,
    });
    if (!committed.ok) return err(dependencyFailure(committed.error, 'document.commit'));

    return ok({
      documentId: document.value.id,
      organizationId: document.value.organizationId,
      name: document.value.name,
      storageKey: document.value.storageKey,
      status: 'active',
    });
  }
}
