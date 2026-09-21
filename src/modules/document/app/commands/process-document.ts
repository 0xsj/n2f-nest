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
import {
  DOCUMENT_EVENT_TYPES,
  type Document,
  type DocumentFailure,
  type DocumentEventType,
} from '../../domain/index.js';
import type { DocumentReader, DocumentWriter } from '../ports/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type DocumentApplicationFailure,
} from '../failures.js';

export type ProcessDocumentCommand = Readonly<{
  organizationId: ID;
  documentId: ID;
  failureCode?: unknown;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type ProcessDocumentDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  documents: DocumentReader;
  writer: DocumentWriter;
}>;

export type ProcessDocumentResult = Readonly<{
  documentId: ID;
  organizationId: ID;
  status: Document['status'];
  processingFailureCode: string | null;
}>;

type Action = 'begin' | 'complete' | 'fail';

function nextId(ids: IDGenerator): Result<ID, DocumentApplicationFailure> {
  const generated = ids.newId();
  return generated.ok
    ? generated
    : err(idGenerationFailure(generated.error));
}

function transition(
  document: Document,
  action: Action,
  at: Date,
  failureCode: unknown,
): Result<Document, DocumentFailure> {
  switch (action) {
    case 'begin':
      return document.beginProcessing(at);
    case 'complete':
      return document.markProcessed(at);
    case 'fail':
      return document.markProcessingFailed(at, failureCode);
  }
}

export class ProcessDocument {
  constructor(
    private readonly dependencies: ProcessDocumentDependencies,
    private readonly action: Action,
    private readonly operation: string,
    private readonly eventType: DocumentEventType,
  ) {}

  async execute(
    command: ProcessDocumentCommand,
  ): Promise<Result<ProcessDocumentResult, DocumentApplicationFailure>> {
    if (command.work.snapshot().operation !== this.operation) {
      return err(
        failure('invalid', 'document processing operation is invalid', {
          type: 'document.invalid_operation',
        }),
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

    const at = this.dependencies.clock.now();
    const changed = transition(
      current.value,
      this.action,
      at,
      command.failureCode,
    );
    if (!changed.ok) return changed;

    // Expected redeliveries are successful no-ops. This is important when the
    // same NATS message is delivered again after a consumer restart.
    if (changed.value === current.value) {
      return ok(resultOf(changed.value));
    }

    const eventId = nextId(this.dependencies.ids);
    if (!eventId.ok) return eventId;
    const event = Envelope.create(
      eventId.value,
      this.eventType,
      at.getTime(),
      command.work,
      {
        organization_id: changed.value.organizationId,
        document_id: changed.value.id,
        status: changed.value.status,
        processing_failure_code: changed.value.processingFailureCode,
      },
    );
    if (!event.ok) return err(dependencyFailure(event.error, 'event.create'));

    const committed = await this.dependencies.writer.commit({
      mode: 'update',
      document: changed.value,
      event: event.value,
      work: command.work,
      signal: command.signal,
    });
    if (!committed.ok) return err(dependencyFailure(committed.error, 'document.commit'));

    return ok(resultOf(changed.value));
  }
}

function resultOf(document: Document): ProcessDocumentResult {
  return {
    documentId: document.id,
    organizationId: document.organizationId,
    status: document.status,
    processingFailureCode: document.processingFailureCode,
  };
}

export class BeginDocumentProcessing extends ProcessDocument {
  constructor(dependencies: ProcessDocumentDependencies) {
    super(
      dependencies,
      'begin',
      'document.processing.start',
      DOCUMENT_EVENT_TYPES.processingStarted,
    );
  }
}

export class CompleteDocumentProcessing extends ProcessDocument {
  constructor(dependencies: ProcessDocumentDependencies) {
    super(
      dependencies,
      'complete',
      'document.processing.complete',
      DOCUMENT_EVENT_TYPES.processingCompleted,
    );
  }
}

export class FailDocumentProcessing extends ProcessDocument {
  constructor(dependencies: ProcessDocumentDependencies) {
    super(
      dependencies,
      'fail',
      'document.processing.fail',
      DOCUMENT_EVENT_TYPES.processingFailed,
    );
  }
}
