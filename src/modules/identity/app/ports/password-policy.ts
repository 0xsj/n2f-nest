import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';

/** Policy validation is separate from hashing so security policy can evolve. */
export interface PasswordPolicy {
  validate(password: SecretString): Result<void, Failure>;
}
