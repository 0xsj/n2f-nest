import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { Identity } from '../../domain/index.js';

export interface IdentityReader {
  find(
    identityId: ID,
    signal?: AbortSignal,
  ): Promise<Result<Identity | null, Failure>>;
}
