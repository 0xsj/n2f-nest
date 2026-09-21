import type { Failure, Result } from '../../../../shared/errors/index.js';

export interface SessionPolicy {
  expiresAt(createdAt: Date): Result<Date, Failure>;
}
