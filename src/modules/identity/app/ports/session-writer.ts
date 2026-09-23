import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { Envelope } from '../../../../shared/events/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type { Credential, Session } from '../../domain/index.js';

/** A session a login revokes to stay within the per-identity cap, with its event. */
export type SessionEviction = Readonly<{ session: Session; event: Envelope }>;

export interface SessionWriter {
  /**
   * Stores the new session and, in the same transaction, the revocation of
   * each evicted session (version-checked, so a concurrent change fails the
   * login with a stale write rather than being overwritten). The session is
   * stored only if `credential` is still active and unchanged since the login
   * checked its password, so a password reset that commits meanwhile cannot
   * be outlived by a session opened with the old password.
   */
  commit(
    input: Readonly<{
      session: Session;
      credential: Credential;
      tokenDigest: SecretString;
      event: Envelope;
      evicted: readonly SessionEviction[];
      work: WorkContext;
    }>,
    signal?: AbortSignal,
  ): Promise<Result<void, Failure>>;
}
