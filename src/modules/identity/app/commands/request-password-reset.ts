import { err, ok, type Result } from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import type { WallClock } from '../../../../shared/clock/index.js';
import type { IDGenerator } from '../../../../shared/id/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import { IDENTITY_EVENT_TYPES, VerificationChallenge, normalizeEmail } from '../../domain/index.js';
import type {
  CredentialAuthenticatorReader,
  IdentityMailer,
  VerificationChallengeWriter,
  VerificationPolicy,
  VerificationTokenIssuer,
} from '../ports/index.js';
import { dependencyFailure, idGenerationFailure, type IdentityApplicationFailure } from '../failures.js';

export type RequestPasswordResetCommand = Readonly<{
  email: unknown;
  work: WorkContext;
  signal?: AbortSignal;
}>;

/** `mailed` is for logs only; callers answer alike either way. */
export type RequestPasswordResetResult = Readonly<{ accepted: true; mailed: boolean }>;

export type RequestPasswordResetDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  credentials: CredentialAuthenticatorReader;
  policy: VerificationPolicy;
  tokens: VerificationTokenIssuer;
  writer: VerificationChallengeWriter;
  mailer: IdentityMailer;
}>;

/**
 * Mails a single-use password-reset link to an address with an active
 * credential, whether or not its identity is verified yet: proving the
 * mailbox is what a reset needs. Unknown, suspended and disabled accounts get
 * nothing, and every address gets the same answer.
 */
export class RequestPasswordReset {
  constructor(private readonly dependencies: RequestPasswordResetDependencies) {}

  async execute(
    command: RequestPasswordResetCommand,
  ): Promise<Result<RequestPasswordResetResult, IdentityApplicationFailure>> {
    const email = normalizeEmail(command.email);
    if (!email.ok) return email;

    const record = await this.dependencies.credentials.findByEmail(email.value, command.signal);
    if (!record.ok) return err(dependencyFailure(record.error, 'credential_reader'));
    const status = record.value?.identity.status;
    if (record.value === null || (status !== 'active' && status !== 'pending_verification')) {
      return ok({ accepted: true, mailed: false });
    }

    const issuedAt = this.dependencies.clock.now();
    const expiresAt = this.dependencies.policy.expiresAt(issuedAt);
    if (!expiresAt.ok) return err(dependencyFailure(expiresAt.error, 'password_reset_policy'));
    const challengeId = this.dependencies.ids.newId();
    if (!challengeId.ok) return err(idGenerationFailure(challengeId.error));
    const challenge = VerificationChallenge.issue({
      id: challengeId.value,
      identityId: record.value.identity.id,
      purpose: 'password_reset',
      issuedAt,
      expiresAt: expiresAt.value,
    });
    if (!challenge.ok) return challenge;

    const token = await this.dependencies.tokens.issue(command.signal);
    if (!token.ok) return err(dependencyFailure(token.error, 'verification_token_issuer'));
    const eventId = this.dependencies.ids.newId();
    if (!eventId.ok) return err(idGenerationFailure(eventId.error));
    const event = Envelope.create(
      eventId.value,
      IDENTITY_EVENT_TYPES.verificationChallengeIssued,
      issuedAt.getTime(),
      command.work,
      {
        identity_id: challenge.value.identityId,
        challenge_id: challenge.value.id,
        purpose: challenge.value.purpose,
        expires_at_ms: challenge.value.expiresAt.getTime(),
      },
      { kind: 'identity', id: challenge.value.identityId },
    );
    if (!event.ok) return err(dependencyFailure(event.error, 'verification_challenge_event'));

    const committed = await this.dependencies.writer.commit(
      { challenge: challenge.value, tokenDigest: token.value.digest, event: event.value, work: command.work },
      command.signal,
    );
    if (!committed.ok) return err(dependencyFailure(committed.error, 'verification_challenge_writer'));

    const sent = this.dependencies.mailer.sendPasswordReset({
      to: email.value,
      challengeId: challenge.value.id,
      token: token.value.token,
      expiresAt: challenge.value.expiresAt,
    });
    return ok({ accepted: true, mailed: sent.ok });
  }
}
