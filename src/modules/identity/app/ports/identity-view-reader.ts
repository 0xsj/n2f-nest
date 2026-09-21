import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { IdentityStatus } from '../../domain/index.js';

export type IdentityView = Readonly<{
  identityId: ID;
  status: IdentityStatus;
  verifiedAt: Date | null;
}>;

/** Read-side projection boundary; it does not return the domain entity. */
export interface IdentityViewReader {
  findById(
    identityId: ID,
    signal?: AbortSignal,
  ): Promise<Result<IdentityView | null, Failure>>;
}
