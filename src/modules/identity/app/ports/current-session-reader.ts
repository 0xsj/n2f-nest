import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type { Session } from '../../domain/index.js';

/** Resolves a transport credential to a session without exposing its digest. */
export interface CurrentSessionReader {
  findByToken(
    token: SecretString,
    signal?: AbortSignal,
  ): Promise<Result<Session | null, Failure>>;
}
