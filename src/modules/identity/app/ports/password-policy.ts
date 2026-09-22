import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';

/**
 * The bounds are Identity policy, not crypto parameters. Keeping them beside
 * the port makes registration and authentication enforce the same contract.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 1024;

/** Policy validation is separate from hashing so security policy can evolve. */
export interface PasswordPolicy {
  validate(password: SecretString): Result<void, Failure>;
}
