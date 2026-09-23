import { err, failure, ok, type Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { DocumentReader } from '../ports/index.js';
import { dependencyFailure, type DocumentApplicationFailure } from '../failures.js';

export type CheckDocumentProcessableQuery = Readonly<{
  organizationId: ID;
  documentId: ID;
  signal?: AbortSignal;
}>;

export type CheckDocumentProcessableDependencies = Readonly<{
  documents: DocumentReader;
}>;

/**
 * Whether processing may begin for a document, with the failure beginning
 * would return if not. A workflow asks before creating work for the document;
 * the caller has already authorized the organization.
 */
export class CheckDocumentProcessable {
  constructor(private readonly dependencies: CheckDocumentProcessableDependencies) {}

  async execute(
    query: CheckDocumentProcessableQuery,
  ): Promise<Result<void, DocumentApplicationFailure>> {
    const found = await this.dependencies.documents.findById(query.documentId, query.signal);
    if (!found.ok) return err(dependencyFailure(found.error, 'document.findById'));
    const document = found.value;
    if (document === null || document.organizationId !== query.organizationId) {
      return err(failure('not_found', 'document was not found', { type: 'document.not_found' }));
    }
    if (document.status === 'archived') {
      return err(
        failure('invalid', 'archived documents cannot be processed', { type: 'document.archived' }),
      );
    }
    if (document.status === 'processed') {
      return err(
        failure('invalid', 'document has already been processed', {
          type: 'document.already_processed',
        }),
      );
    }
    return ok(undefined);
  }
}
