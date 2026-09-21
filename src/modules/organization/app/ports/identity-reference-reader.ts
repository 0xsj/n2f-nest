import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';

export type IdentityReference = Readonly<{
  identityId: ID;
}>;

export interface IdentityReferenceReader {
  findActive(
    identityId: ID,
    signal?: AbortSignal,
  ): Promise<Result<IdentityReference | null, Failure>>;
}
