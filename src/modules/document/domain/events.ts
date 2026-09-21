/** Event names owned by the Document bounded context.
 *
 * The application layer adds transport concerns such as IDs, provenance and
 * outbox envelopes. Keeping the vocabulary here prevents adapters and
 * workflows from inventing competing names.
 */
export const DOCUMENT_EVENT_TYPES = Object.freeze({
  created: 'document.created.v1',
  processingStarted: 'document.processing.started.v1',
  processingCompleted: 'document.processing.completed.v1',
  processingFailed: 'document.processing.failed.v1',
  archived: 'document.archived.v1',
} as const);

export type DocumentEventType =
  (typeof DOCUMENT_EVENT_TYPES)[keyof typeof DOCUMENT_EVENT_TYPES];
