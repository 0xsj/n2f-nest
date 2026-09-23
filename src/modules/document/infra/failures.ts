import { failure, type Failure } from '../../../shared/errors/index.js';

/** Another operation changed the document after this operation read it. */
export const staleWrite = (): Failure =>
  failure('conflict', 'document was changed by a concurrent operation', {
    type: 'document.stale_write',
  });

export const documentExists = (): Failure =>
  failure('conflict', 'document already exists', { type: 'document.already_exists' });

export const documentNotFound = (): Failure =>
  failure('not_found', 'document was not found', { type: 'document.not_found' });

export const CONSTRAINTS = Object.freeze({
  documentPkey: 'n2f_document_documents_pkey',
});
