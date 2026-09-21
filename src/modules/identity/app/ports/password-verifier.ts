import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';

export interface PasswordVerifier {
  verify(
    password: SecretString,
    passwordHash: SecretString,
    signal?: AbortSignal,
  ): Promise<Result<boolean, Failure>>;
}
