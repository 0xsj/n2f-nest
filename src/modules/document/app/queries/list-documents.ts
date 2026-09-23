import {
  err,
  failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import { position, request, window, type Page } from '../../../../shared/pagination/index.js';
import type { Document } from '../../domain/index.js';
import type { DocumentReader, OrganizationAccessReader } from '../ports/index.js';
import { dependencyFailure, invalidPage, type DocumentApplicationFailure } from '../failures.js';

export type ListDocumentsQuery = Readonly<{
  sessionToken: SecretString;
  organizationId: ID;
  /** Page size as received (1–100, default 25). */
  limit?: string;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
  work?: WorkContext;
  signal?: AbortSignal;
}>;

export type ListDocumentsDependencies = Readonly<{
  access: OrganizationAccessReader;
  documents: DocumentReader;
}>;

export class ListDocuments {
  constructor(private readonly dependencies: ListDocumentsDependencies) {}

  async execute(
    query: ListDocumentsQuery,
  ): Promise<Result<Page<Document>, DocumentApplicationFailure>> {
    const scope = `documents:${query.organizationId}`;
    const page = request(scope, query.limit, query.cursor);
    if (!page.ok) return err(invalidPage());
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
    const documents = await this.dependencies.documents.listForOrganization(
      query.organizationId,
      page.value,
      query.signal,
    );
    if (!documents.ok) {
      return err(dependencyFailure(documents.error, 'document.listForOrganization'));
    }
    const windowed = window(documents.value, page.value.limit, scope, (document) =>
      position(document.createdAt, document.id),
    );
    return windowed.ok ? windowed : err(dependencyFailure(windowed.error, 'pagination.window'));
  }
}
