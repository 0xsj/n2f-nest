import { err, ok, typedFailure, type Result } from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import type { WallClock } from '../../../../shared/clock/index.js';
import type { ID, IDGenerator } from '../../../../shared/id/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import { IDENTITY_EVENT_TYPES, type Identity } from '../../domain/index.js';
import type {
  ActiveSessionReader,
  CredentialAuthenticatorReader,
  PasswordHasher,
  PasswordPolicy,
  PasswordResetWriter,
  SessionEviction,
  VerificationChallengeReader,
  VerificationTokenVerifier,
} from '../ports/index.js';
import { dependencyFailure, idGenerationFailure, type IdentityApplicationFailure } from '../failures.js';

export type ConfirmPasswordResetCommand = Readonly<{
  challengeId: ID;
  token: SecretString;
  password: SecretString;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type ConfirmPasswordResetResult = Readonly<{
  identityId: ID;
  /** Whether the reset also verified an identity that was pending. */
  verified: boolean;
  sessionsRevoked: number;
}>;

export type ConfirmPasswordResetDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  challenges: VerificationChallengeReader;
  tokens: VerificationTokenVerifier;
  credentials: CredentialAuthenticatorReader;
  passwordPolicy: PasswordPolicy;
  passwordHasher: PasswordHasher;
  sessions: ActiveSessionReader;
  writer: PasswordResetWriter;
}>;

/** One refusal for a missing, mismatched, used or expired link: nothing to probe. */
function invalidLink(): IdentityApplicationFailure {
  return typedFailure('unauthenticated', 'identity.invalid_verification_token', 'reset link is invalid');
}

/**
 * Sets a new password from a mailed reset link. The link proves the mailbox,
 * so a pending identity is verified too: an address someone else signed up
 * with is recovered by its owner. Every session is revoked, so whoever knew
 * the old password is signed out. All of it commits atomically.
 */
export class ConfirmPasswordReset {
  constructor(private readonly dependencies: ConfirmPasswordResetDependencies) {}

  async execute(
    command: ConfirmPasswordResetCommand,
  ): Promise<Result<ConfirmPasswordResetResult, IdentityApplicationFailure>> {
    const policy = this.dependencies.passwordPolicy.validate(command.password);
    if (!policy.ok) return err(dependencyFailure(policy.error, 'password_policy'));

    const record = await this.dependencies.challenges.find(command.challengeId, command.signal);
    if (!record.ok) return err(dependencyFailure(record.error, 'verification_challenge_reader'));
    if (record.value === null || record.value.challenge.purpose !== 'password_reset') return err(invalidLink());

    const token = await this.dependencies.tokens.verify(command.token, record.value.tokenDigest, command.signal);
    if (!token.ok) return err(dependencyFailure(token.error, 'verification_token_verifier'));
    if (!token.value) return err(invalidLink());

    const at = this.dependencies.clock.now();
    const consumed = record.value.challenge.consume(at);
    if (!consumed.ok) return err(invalidLink());

    const account = await this.dependencies.credentials.findByIdentity(consumed.value.identityId, command.signal);
    if (!account.ok) return err(dependencyFailure(account.error, 'credential_reader'));
    if (account.value === null) return err(invalidLink());
    const { identity, credential } = account.value;
    if (identity.status !== 'active' && identity.status !== 'pending_verification') return err(invalidLink());

    const changed = credential.changeSecret(at);
    if (!changed.ok) return changed;
    let verified: Identity | null = null;
    if (identity.status === 'pending_verification') {
      const result = identity.verify(at);
      if (!result.ok) return result;
      verified = result.value;
    }

    const passwordHash = await this.dependencies.passwordHasher.hash(command.password, command.signal);
    if (!passwordHash.ok) return err(dependencyFailure(passwordHash.error, 'password_hasher'));

    const active = await this.dependencies.sessions.listActive(identity.id, command.signal);
    if (!active.ok) return err(dependencyFailure(active.error, 'active_session_reader'));

    const event = (type: string, payload: Record<string, unknown>) => {
      const eventId = this.dependencies.ids.newId();
      if (!eventId.ok) return err(idGenerationFailure(eventId.error));
      const envelope = Envelope.create(eventId.value, type, at.getTime(), command.work, payload, {
        kind: 'identity',
        id: identity.id,
      });
      return envelope.ok ? envelope : err(dependencyFailure(envelope.error, 'password_reset_event'));
    };

    const revoked: SessionEviction[] = [];
    for (const session of active.value) {
      const ended = session.revoke(at);
      if (!ended.ok) return ended;
      const revocation = event(IDENTITY_EVENT_TYPES.sessionRevoked, {
        identity_id: identity.id,
        session_id: session.id,
        status: ended.value.status,
        reason: 'password_reset',
      });
      if (!revocation.ok) return revocation;
      revoked.push({ session: ended.value, event: revocation.value });
    }

    const reset = event(IDENTITY_EVENT_TYPES.passwordReset, {
      identity_id: identity.id,
      credential_id: credential.id,
      challenge_id: consumed.value.id,
      sessions_revoked: revoked.length,
    });
    if (!reset.ok) return reset;
    const events = [reset.value];
    if (verified) {
      const verification = event(IDENTITY_EVENT_TYPES.verified, {
        identity_id: identity.id,
        challenge_id: consumed.value.id,
        purpose: consumed.value.purpose,
        status: verified.status,
      });
      if (!verification.ok) return verification;
      events.push(verification.value);
    }

    const committed = await this.dependencies.writer.commit(
      {
        challenge: consumed.value,
        credential: changed.value,
        previousUpdatedAt: credential.updatedAt,
        passwordHash: passwordHash.value,
        identity: verified,
        revoked,
        events: [...events, ...revoked.map((eviction) => eviction.event)],
        work: command.work,
      },
      command.signal,
    );
    if (!committed.ok) return err(dependencyFailure(committed.error, 'password_reset_writer'));

    return ok({ identityId: identity.id, verified: verified !== null, sessionsRevoked: revoked.length });
  }
}
