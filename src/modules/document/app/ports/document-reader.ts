import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { Document } from '../../domain/index.js';

export interface DocumentReader {
  findById(id: ID, signal?: AbortSignal): Promise<Result<Document | null, Failure>>;
  listForOrganization(
    organizationId: ID,
    signal?: AbortSignal,
  ): Promise<Result<readonly Document[], Failure>>;
}
