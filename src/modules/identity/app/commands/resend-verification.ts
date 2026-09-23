import { err, ok, type Result } from '../../../../shared/errors/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import { normalizeEmail } from '../../domain/index.js';
import type { CredentialAuthenticatorReader, IdentityMailer } from '../ports/index.js';
import { dependencyFailure, type IdentityApplicationFailure } from '../failures.js';
import type { IssueVerificationChallenge } from './issue-verification-challenge.js';

export type ResendVerificationCommand = Readonly<{
  email: unknown;
  work: WorkContext;
  signal?: AbortSignal;
}>;

/** `mailed` is for logs only; callers answer alike either way. */
export type ResendVerificationResult = Readonly<{ accepted: true; mailed: boolean }>;

export type ResendVerificationDependencies = Readonly<{
  credentials: CredentialAuthenticatorReader;
  challenges: Pick<IssueVerificationChallenge, 'execute'>;
  mailer: IdentityMailer;
}>;

/**
 * Mails a fresh verification link to an email whose identity still awaits
 * verification. Unknown and already verified emails get nothing, and the
 * answer is the same, so it reveals no account.
 */
export class ResendVerification {
  constructor(private readonly dependencies: ResendVerificationDependencies) {}

  async execute(
    command: ResendVerificationCommand,
  ): Promise<Result<ResendVerificationResult, IdentityApplicationFailure>> {
    const email = normalizeEmail(command.email);
    if (!email.ok) return email;

    const record = await this.dependencies.credentials.findByEmail(email.value, command.signal);
    if (!record.ok) return err(dependencyFailure(record.error, 'credential_reader'));
    if (record.value === null || record.value.identity.status !== 'pending_verification') {
      return ok({ accepted: true, mailed: false });
    }

    const challenge = await this.dependencies.challenges.execute({
      identityId: record.value.identity.id,
      work: command.work,
      signal: command.signal,
    });
    if (!challenge.ok) return challenge;

    const sent = this.dependencies.mailer.sendVerification({
      to: email.value,
      challengeId: challenge.value.challengeId,
      token: challenge.value.token,
      expiresAt: challenge.value.expiresAt,
    });
    return ok({ accepted: true, mailed: sent.ok });
  }
}
