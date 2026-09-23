import {
  err,
  ok,
  typedFailure,
  type TypedFailure,
  type Result,
} from '../../../shared/errors/index.js';
import type { ID } from '../../../shared/id/index.js';
import {
  UNSAVED,
  isStoredVersion,
  type Version,
} from '../../../shared/version/index.js';

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
  | 'document.invalid_processing_failed_at'
  | 'document.invalid_processing_outcome';

export type DocumentFailure = TypedFailure<'invalid', DocumentFailureType>;

/**
 * An outcome of the processing run a document is waiting on. `run` is an
 * opaque reference to that run (the workflow uses its job ID); `attempt`
 * orders outcomes of the same run, so a late or repeated delivery is ignored.
 */
export type ProcessingOutcome = Readonly<{
  run: ID;
  attempt: number;
  result: 'retrying' | 'succeeded' | 'failed';
  failureCode?: unknown;
}>;

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
  processingRun: ID | null;
  processingAttempt: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  version: Version;
}>;

type DocumentState = Readonly<{
  id: ID;
  organizationId: ID;
  name: string;
  storageKey: string | null;
  status: DocumentStatus;
  processingFailureCode: string | null;
  processingRun: ID | null;
  processingAttempt: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  version: Version;
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
        processingRun: null,
        processingAttempt: 0,
        createdAt,
        updatedAt: copyDate(createdAt),
        archivedAt: null,
        version: UNSAVED,
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
      (input.archivedAt !== null && !validDate(input.archivedAt)) ||
      !isStoredVersion(input.version) ||
      !Number.isSafeInteger(input.processingAttempt) ||
      input.processingAttempt < 0
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
        processingRun: input.processingRun,
        processingAttempt: input.processingAttempt,
        createdAt: copyDate(input.createdAt),
        updatedAt: copyDate(input.updatedAt),
        archivedAt:
          input.archivedAt === null ? null : copyDate(input.archivedAt),
        version: input.version,
      }),
    );
  }

  /** The optimistic-concurrency token this state was loaded at. */
  get version(): Version {
    return this.state.version;
  }

  /** This state as storage holds it after a successful write. */
  saved(): Document {
    return new Document({ ...this.state, version: this.state.version + 1 });
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

  /** The processing run this document is waiting on or last finished. */
  get processingRun(): ID | null {
    return this.state.processingRun;
  }

  /** The latest attempt of the processing run applied to this document. */
  get processingAttempt(): number {
    return this.state.processingAttempt;
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

  /**
   * Start waiting on processing run `run`. Beginning the same run again is a
   * no-op; beginning a different run replaces the one in progress, so outcomes
   * of the older run become stale.
   */
  beginProcessing(at: Date, run: ID): Result<Document, DocumentFailure> {
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
    if (this.status === 'processing' && this.state.processingRun === run) return ok(this);
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
        processingRun: run,
        processingAttempt: 0,
        updatedAt: copyDate(at),
      }),
    );
  }

  /**
   * Apply an outcome of the current processing run. An outcome for another
   * run, an older attempt, a finished run or an archived document is stale
   * and returns this document unchanged: deliveries are at least once and not
   * strictly ordered, so a stale outcome is expected, not an error.
   */
  applyProcessingOutcome(
    at: Date,
    outcome: ProcessingOutcome,
  ): Result<Document, DocumentFailure> {
    if (!validDate(at)) {
      return err(invalid('document processing outcome time is invalid', 'document.invalid_processing_outcome'));
    }
    if (!Number.isSafeInteger(outcome.attempt) || outcome.attempt < 0) {
      return err(invalid('document processing attempt is invalid', 'document.invalid_processing_outcome'));
    }
    const current = this.state;
    const sameRun =
      current.processingRun === outcome.run ||
      // A document already processing before runs were recorded adopts the
      // first run that reports.
      (current.processingRun === null && current.status === 'processing');
    if (
      current.status === 'archived' ||
      current.status === 'active' ||
      current.status === 'processed' ||
      !sameRun ||
      outcome.attempt < current.processingAttempt
    ) {
      return ok(this);
    }
    const updatedAt = copyDate(new Date(Math.max(at.getTime(), current.updatedAt.getTime())));
    const base = { ...current, processingRun: outcome.run, processingAttempt: outcome.attempt, updatedAt };

    switch (outcome.result) {
      case 'succeeded':
        return ok(new Document({ ...base, status: 'processed', processingFailureCode: null }));
      case 'retrying':
        if (current.status === 'processing') {
          return outcome.attempt === current.processingAttempt ? ok(this) : ok(new Document(base));
        }
        return ok(new Document({ ...base, status: 'processing', processingFailureCode: null }));
      case 'failed': {
        const code = processingFailureCode(outcome.failureCode);
        if (!code.ok || code.value === null) {
          return err(invalid('document processing failure code is invalid', 'document.invalid_processing_failure_code'));
        }
        // A later report about an attempt that already failed (such as the
        // job being canceled afterwards) keeps the original failure.
        if (current.status === 'processing_failed' && outcome.attempt === current.processingAttempt) {
          return ok(this);
        }
        return ok(new Document({ ...base, status: 'processing_failed', processingFailureCode: code.value }));
      }
    }
  }
}
