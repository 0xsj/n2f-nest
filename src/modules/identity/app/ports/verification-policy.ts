import type { Failure, Result } from '../../../../shared/errors/index.js';

export interface VerificationPolicy {
  expiresAt(issuedAt: Date): Result<Date, Failure>;
}
