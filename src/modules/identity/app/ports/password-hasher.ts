import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';

/** Cryptographic implementation belongs to infrastructure. */
export interface PasswordHasher {
  hash(
    password: SecretString,
    signal?: AbortSignal,
  ): Promise<Result<SecretString, Failure>>;
}
