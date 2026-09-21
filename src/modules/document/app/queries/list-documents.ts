import {
  err,
  failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type { Document } from '../../domain/index.js';
import type { DocumentReader, OrganizationAccessReader } from '../ports/index.js';
import { dependencyFailure, type DocumentApplicationFailure } from '../failures.js';

export type ListDocumentsQuery = Readonly<{
  sessionToken: SecretString;
  organizationId: ID;
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
  ): Promise<Result<readonly Document[], DocumentApplicationFailure>> {
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
      query.signal,
    );
    return documents.ok
      ? documents
      : err(dependencyFailure(documents.error, 'document.listForOrganization'));
  }
}
