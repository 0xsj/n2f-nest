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
import type {
  DocumentReader,
  DocumentWriter,
  OrganizationAccessReader,
} from '../ports/index.js';
import { DOCUMENT_EVENT_TYPES } from '../../domain/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type DocumentApplicationFailure,
} from '../failures.js';

export type ArchiveDocumentCommand = Readonly<{
  sessionToken: SecretString;
  organizationId: ID;
  documentId: ID;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type ArchiveDocumentDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  access: OrganizationAccessReader;
  documents: DocumentReader;
  writer: DocumentWriter;
}>;

export type ArchiveDocumentResult = Readonly<{
  documentId: ID;
  status: 'archived';
  archivedAt: Date;
}>;

function nextId(ids: IDGenerator): Result<ID, DocumentApplicationFailure> {
  const generated = ids.newId();
  return generated.ok
    ? generated
    : err(idGenerationFailure(generated.error));
}

export class ArchiveDocument {
  constructor(private readonly dependencies: ArchiveDocumentDependencies) {}

  async execute(
    command: ArchiveDocumentCommand,
  ): Promise<Result<ArchiveDocumentResult, DocumentApplicationFailure>> {
    if (command.work.snapshot().operation !== 'document.archive') {
      return err(
        failure('invalid', 'document archive operation is invalid', {
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
    if (
      access.value === null ||
      (access.value.role !== 'owner' && access.value.role !== 'admin')
    ) {
      return err(
        failure(
          'forbidden',
          'only organization owners and admins can archive documents',
          {
            type: 'document.archive_forbidden',
          },
        ),
      );
    }

    const current = await this.dependencies.documents.findById(
      command.documentId,
      command.signal,
    );
    if (!current.ok) return err(dependencyFailure(current.error, 'document.findById'));
    if (
      current.value === null ||
      current.value.organizationId !== command.organizationId
    ) {
      return err(
        failure('not_found', 'document was not found', {
          type: 'document.not_found',
        }),
      );
    }

    const archivedAt = this.dependencies.clock.now();
    const archived = current.value.archive(archivedAt);
    if (!archived.ok) return archived;

    const eventId = nextId(this.dependencies.ids);
    if (!eventId.ok) return eventId;
    const event = Envelope.create(
      eventId.value,
      DOCUMENT_EVENT_TYPES.archived,
      archivedAt.getTime(),
      command.work,
      {
        organization_id: archived.value.organizationId,
        document_id: archived.value.id,
        identity_id: access.value.identityId,
        status: archived.value.status,
        archived_at: archived.value.archivedAt?.toISOString(),
      },
    );
    if (!event.ok) return err(dependencyFailure(event.error, 'event.create'));

    const committed = await this.dependencies.writer.commit({
      mode: 'update',
      document: archived.value,
      event: event.value,
      work: command.work,
      signal: command.signal,
    });
    if (!committed.ok) return err(dependencyFailure(committed.error, 'document.commit'));

    return ok({
      documentId: archived.value.id,
      status: 'archived',
      archivedAt: archived.value.archivedAt!,
    });
  }
}
