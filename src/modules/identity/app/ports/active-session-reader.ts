import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { Session } from '../../domain/index.js';

/** An identity's sessions that are not revoked, newest first. */
export interface ActiveSessionReader {
  listActive(identityId: ID, signal?: AbortSignal): Promise<Result<readonly Session[], Failure>>;
}
