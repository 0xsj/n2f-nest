import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { Envelope } from '../../../../shared/events/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type { Credential, Identity, VerificationChallenge } from '../../domain/index.js';
import type { SessionEviction } from './session-writer.js';

export interface PasswordResetWriter {
  /**
   * Atomically: consumes the reset challenge (version-checked), stores the new
   * password hash only if the credential is unchanged since it was read
   * (`previousUpdatedAt`), verifies the identity when `identity` is given
   * (version-checked), revokes every listed session (version-checked) and
   * records every event. Any concurrent change fails the whole reset with a
   * stale write.
   */
  commit(
    input: Readonly<{
      challenge: VerificationChallenge;
      credential: Credential;
      previousUpdatedAt: Date;
      passwordHash: SecretString;
      identity: Identity | null;
      revoked: readonly SessionEviction[];
      events: readonly Envelope[];
      work: WorkContext;
    }>,
    signal?: AbortSignal,
  ): Promise<Result<void, Failure>>;
}
