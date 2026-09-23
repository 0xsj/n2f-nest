import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';

export interface PasswordVerifier {
  verify(
    password: SecretString,
    passwordHash: SecretString,
    signal?: AbortSignal,
  ): Promise<Result<boolean, Failure>>;

  /**
   * Spend the same work as `verify` against a hash that matches no password,
   * and return false. Login calls it when no credential exists, so response
   * time does not reveal which emails are registered.
   */
  verifyDecoy(password: SecretString, signal?: AbortSignal): Promise<Result<false, Failure>>;
}
