import type { Envelope } from '../../../../shared/events/index.js';
import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { Document } from '../../domain/index.js';

export type DocumentCommit = Readonly<{
  mode: 'create' | 'update';
  document: Document;
  event: Envelope;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export interface DocumentWriter {
  commit(input: DocumentCommit): Promise<Result<void, Failure>>;
}
