import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';

export type VerificationTokenMaterial = Readonly<{
  token: SecretString;
  digest: SecretString;
}>;

/** Issues a one-time token without exposing token storage to the application. */
export interface VerificationTokenIssuer {
  issue(
    signal?: AbortSignal,
  ): Promise<Result<VerificationTokenMaterial, Failure>>;
}
