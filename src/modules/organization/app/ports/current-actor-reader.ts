import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';

export type CurrentActor = Readonly<{
  identityId: ID;
}>;

/** Resolves an authenticated transport credential into an active actor. */
export interface CurrentActorReader {
  findCurrent(
    sessionToken: SecretString,
    signal?: AbortSignal,
  ): Promise<Result<CurrentActor, Failure>>;
}
