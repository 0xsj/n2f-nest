import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { After } from '../../../../shared/pagination/index.js';
import type { Document } from '../../domain/index.js';

export interface DocumentReader {
  findById(id: ID, signal?: AbortSignal): Promise<Result<Document | null, Failure>>;
  /** Up to `limit + 1` documents ordered by (createdAt, id), after `page.after`. */
  listForOrganization(
    organizationId: ID,
    page: Readonly<{ limit: number; after?: After }>,
    signal?: AbortSignal,
  ): Promise<Result<readonly Document[], Failure>>;
}
