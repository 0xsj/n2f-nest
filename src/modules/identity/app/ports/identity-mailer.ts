import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type { EmailAddress } from '../../domain/index.js';

/**
 * Identity's outgoing mail. Sending hands a message to delivery and returns
 * without waiting for it, so the time a request takes does not depend on
 * which message (if any) was sent.
 */
export interface IdentityMailer {
  /** The link that proves ownership of `to` and verifies the identity. */
  sendVerification(
    input: Readonly<{ to: EmailAddress; challengeId: ID; token: SecretString; expiresAt: Date }>,
  ): Result<void, Failure>;
  /** The link that lets the owner of `to` set a new password. */
  sendPasswordReset(
    input: Readonly<{ to: EmailAddress; challengeId: ID; token: SecretString; expiresAt: Date }>,
  ): Result<void, Failure>;
  /** Tells the owner of `to` that someone tried to sign up with it again. */
  sendAccountExists(input: Readonly<{ to: EmailAddress }>): Result<void, Failure>;
}
