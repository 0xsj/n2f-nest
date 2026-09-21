import {
  err,
  ok,
  typedFailure,
  type TypedFailure,
  type Result,
} from '../../../shared/errors/index.js';
import type { ID } from '../../../shared/id/index.js';

export const DOCUMENT_STATUSES = Object.freeze([
  'active',
  'processing',
  'processed',
  'processing_failed',
  'archived',
] as const);
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export type DocumentFailureType =
  | 'document.invalid_name'
  | 'document.invalid_storage_key'
  | 'document.invalid_processing_failure_code'
  | 'document.invalid_created_at'
  | 'document.invalid_state'
  | 'document.non_monotonic_time'
  | 'document.invalid_archived_at'
  | 'document.already_archived'
  | 'document.invalid_processing_started_at'
  | 'document.archived'
  | 'document.already_processed'
  | 'document.invalid_processing_completed_at'
  | 'document.not_processing'
  | 'document.invalid_processing_failed_at';

export type DocumentFailure = TypedFailure<'invalid', DocumentFailureType>;

export type CreateDocumentInput = Readonly<{
  id: ID;
  organizationId: ID;
  name: unknown;
  storageKey?: unknown;
  createdAt: Date;
}>;

export type RestoreDocumentInput = Readonly<{
  id: ID;
  organizationId: ID;
  name: unknown;
  storageKey: unknown;
  status: DocumentStatus;
  processingFailureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}>;

type DocumentState = Readonly<{
  id: ID;
  organizationId: ID;
  name: string;
  storageKey: string | null;
  status: DocumentStatus;
  processingFailureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}>;

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function copyDate(value: Date): Date {
  return new Date(value.getTime());
}

function invalid(message: string, type: DocumentFailureType): DocumentFailure {
  return typedFailure('invalid', type, message);
}

function name(value: unknown): Result<string, DocumentFailure> {
  if (typeof value !== 'string') {
    return err(
      invalid('document name must be a string', 'document.invalid_name'),
    );
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    return err(
      invalid(
        'document name must be between 1 and 200 characters',
        'document.invalid_name',
      ),
    );
  }
  return ok(normalized);
}

function storageKey(value: unknown): Result<string | null, DocumentFailure> {
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== 'string') {
    return err(
      invalid(
        'document storage key must be a string',
        'document.invalid_storage_key',
      ),
    );
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 512) {
    return err(
      invalid(
        'document storage key must be between 1 and 512 characters',
        'document.invalid_storage_key',
      ),
    );
  }
  return ok(normalized);
}

function processingFailureCode(
  value: unknown,
): Result<string | null, DocumentFailure> {
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_.-]{0,127}$/.test(value)) {
    return err(
      invalid(
        'document processing failure code is invalid',
        'document.invalid_processing_failure_code',
      ),
    );
  }
  return ok(value);
}

export class Document {
  private constructor(private readonly state: DocumentState) {
    Object.freeze(this.state);
  }

  static create(input: CreateDocumentInput): Result<Document, DocumentFailure> {
    const documentName = name(input.name);
    if (!documentName.ok) return documentName;
    const documentStorageKey = storageKey(input.storageKey);
    if (!documentStorageKey.ok) return documentStorageKey;
    if (!validDate(input.createdAt)) {
      return err(
        invalid(
          'document creation time is invalid',
          'document.invalid_created_at',
        ),
      );
    }

    const createdAt = copyDate(input.createdAt);
    return ok(
      new Document({
        id: input.id,
        organizationId: input.organizationId,
        name: documentName.value,
        storageKey: documentStorageKey.value,
        status: 'active',
        processingFailureCode: null,
        createdAt,
        updatedAt: copyDate(createdAt),
        archivedAt: null,
      }),
    );
  }

  static restore(
    input: RestoreDocumentInput,
  ): Result<Document, DocumentFailure> {
    const documentName = name(input.name);
    if (!documentName.ok) return documentName;
    const documentStorageKey = storageKey(input.storageKey);
    if (!documentStorageKey.ok) return documentStorageKey;
    const documentProcessingFailureCode = processingFailureCode(
      input.processingFailureCode,
    );
    if (!documentProcessingFailureCode.ok) return documentProcessingFailureCode;
    if (
      !DOCUMENT_STATUSES.includes(input.status) ||
      !validDate(input.createdAt) ||
      !validDate(input.updatedAt) ||
      (input.archivedAt !== null && !validDate(input.archivedAt))
    ) {
      return err(
        invalid('document state is invalid', 'document.invalid_state'),
      );
    }
    if (input.updatedAt.getTime() < input.createdAt.getTime()) {
      return err(
        invalid(
          'document update time cannot precede creation',
          'document.non_monotonic_time',
        ),
      );
    }
    if (
      (['active', 'processing', 'processed'].includes(input.status) &&
        (input.archivedAt !== null ||
          documentProcessingFailureCode.value !== null)) ||
      (input.status === 'processing_failed' &&
        (input.archivedAt !== null ||
          documentProcessingFailureCode.value === null)) ||
      (input.status === 'archived' && input.archivedAt === null)
    ) {
      return err(
        invalid('document archive state is invalid', 'document.invalid_state'),
      );
    }

    return ok(
      new Document({
        id: input.id,
        organizationId: input.organizationId,
        name: documentName.value,
        storageKey: documentStorageKey.value,
        status: input.status,
        processingFailureCode: documentProcessingFailureCode.value,
        createdAt: copyDate(input.createdAt),
        updatedAt: copyDate(input.updatedAt),
        archivedAt:
          input.archivedAt === null ? null : copyDate(input.archivedAt),
      }),
    );
  }

  get id(): ID {
    return this.state.id;
  }

  get organizationId(): ID {
    return this.state.organizationId;
  }

  get name(): string {
    return this.state.name;
  }

  get storageKey(): string | null {
    return this.state.storageKey;
  }

  get processingFailureCode(): string | null {
    return this.state.processingFailureCode;
  }

  get status(): DocumentStatus {
    return this.state.status;
  }

  get createdAt(): Date {
    return copyDate(this.state.createdAt);
  }

  get updatedAt(): Date {
    return copyDate(this.state.updatedAt);
  }

  get archivedAt(): Date | null {
    return this.state.archivedAt === null
      ? null
      : copyDate(this.state.archivedAt);
  }

  archive(at: Date): Result<Document, DocumentFailure> {
    if (!validDate(at)) {
      return err(
        invalid(
          'document archive time is invalid',
          'document.invalid_archived_at',
        ),
      );
    }
    if (at.getTime() < this.state.updatedAt.getTime()) {
      return err(
        invalid(
          'document archive time cannot move backwards',
          'document.non_monotonic_time',
        ),
      );
    }
    if (this.status === 'archived') {
      return err(
        invalid('document is already archived', 'document.already_archived'),
      );
    }

    const archivedAt = copyDate(at);
    return ok(
      new Document({
        ...this.state,
        status: 'archived',
        updatedAt: archivedAt,
        archivedAt,
      }),
    );
  }

  beginProcessing(at: Date): Result<Document, DocumentFailure> {
    if (!validDate(at)) {
      return err(
        invalid(
          'document processing start time is invalid',
          'document.invalid_processing_started_at',
        ),
      );
    }
    if (at.getTime() < this.state.updatedAt.getTime()) {
      return err(
        invalid(
          'document processing start time cannot move backwards',
          'document.non_monotonic_time',
        ),
      );
    }
    if (this.status === 'archived') {
      return err(
        invalid('archived documents cannot be processed', 'document.archived'),
      );
    }
    if (this.status === 'processing') return ok(this);
    if (this.status === 'processed') {
      return err(
        invalid(
          'document has already been processed',
          'document.already_processed',
        ),
      );
    }

    return ok(
      new Document({
        ...this.state,
        status: 'processing',
        processingFailureCode: null,
        updatedAt: copyDate(at),
      }),
    );
  }

  markProcessed(at: Date): Result<Document, DocumentFailure> {
    if (!validDate(at)) {
      return err(
        invalid(
          'document processing completion time is invalid',
          'document.invalid_processing_completed_at',
        ),
      );
    }
    if (at.getTime() < this.state.updatedAt.getTime()) {
      return err(
        invalid(
          'document processing completion time cannot move backwards',
          'document.non_monotonic_time',
        ),
      );
    }
    if (this.status === 'processed') return ok(this);
    if (this.status !== 'processing') {
      return err(
        invalid(
          'only processing documents can be completed',
          'document.not_processing',
        ),
      );
    }

    return ok(
      new Document({
        ...this.state,
        status: 'processed',
        processingFailureCode: null,
        updatedAt: copyDate(at),
      }),
    );
  }

  markProcessingFailed(
    at: Date,
    code: unknown,
  ): Result<Document, DocumentFailure> {
    if (!validDate(at)) {
      return err(
        invalid(
          'document processing failure time is invalid',
          'document.invalid_processing_failed_at',
        ),
      );
    }
    if (at.getTime() < this.state.updatedAt.getTime()) {
      return err(
        invalid(
          'document processing failure time cannot move backwards',
          'document.non_monotonic_time',
        ),
      );
    }
    const failureCodeValue = processingFailureCode(code);
    if (!failureCodeValue.ok || failureCodeValue.value === null) {
      return err(
        invalid(
          'document processing failure code is invalid',
          'document.invalid_processing_failure_code',
        ),
      );
    }
    if (
      this.status === 'processing_failed' &&
      this.processingFailureCode === failureCodeValue.value
    ) {
      return ok(this);
    }
    if (this.status !== 'processing') {
      return err(
        invalid(
          'only processing documents can fail',
          'document.not_processing',
        ),
      );
    }

    return ok(
      new Document({
        ...this.state,
        status: 'processing_failed',
        processingFailureCode: failureCodeValue.value,
        updatedAt: copyDate(at),
      }),
    );
  }
}
