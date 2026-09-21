import {
  err,
  failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type { Document } from '../../domain/index.js';
import type { DocumentReader, OrganizationAccessReader } from '../ports/index.js';
import { dependencyFailure, type DocumentApplicationFailure } from '../failures.js';

export type GetDocumentQuery = Readonly<{
  sessionToken: SecretString;
  organizationId: ID;
  documentId: ID;
  signal?: AbortSignal;
}>;

export type GetDocumentDependencies = Readonly<{
  access: OrganizationAccessReader;
  documents: DocumentReader;
}>;

export class GetDocument {
  constructor(private readonly dependencies: GetDocumentDependencies) {}

  async execute(
    query: GetDocumentQuery,
  ): Promise<Result<Document, DocumentApplicationFailure>> {
    const access = await this.dependencies.access.find(
      query.sessionToken,
      query.organizationId,
      query.signal,
    );
    if (!access.ok) return err(dependencyFailure(access.error, 'organization.access.find'));
    if (access.value === null) {
      return err(
        failure('forbidden', 'organization access is required', {
          type: 'document.access_forbidden',
        }),
      );
    }

    const document = await this.dependencies.documents.findById(
      query.documentId,
      query.signal,
    );
    if (!document.ok) return err(dependencyFailure(document.error, 'document.findById'));
    if (
      document.value === null ||
      document.value.organizationId !== query.organizationId
    ) {
      return err(
        failure('not_found', 'document was not found', {
          type: 'document.not_found',
        }),
      );
    }
    return { ok: true, value: document.value };
  }
}
