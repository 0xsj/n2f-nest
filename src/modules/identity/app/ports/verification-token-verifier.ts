import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';

export interface VerificationTokenVerifier {
  verify(
    token: SecretString,
    digest: SecretString,
    signal?: AbortSignal,
  ): Promise<Result<boolean, Failure>>;
}
