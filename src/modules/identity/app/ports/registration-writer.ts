import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { Envelope } from '../../../../shared/events/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type { Credential, Identity } from '../../domain/index.js';

/**
 * The registration writer owns one atomic commit of state and its outbox fact.
 * It must not publish the event before the Identity and Credential are durable.
 */
export interface RegistrationWriter {
  commit(
    input: Readonly<{
      identity: Identity;
      credential: Credential;
      passwordHash: SecretString;
      event: Envelope;
      work: WorkContext;
    }>,
    signal?: AbortSignal,
  ): Promise<Result<void, Failure>>;
}
