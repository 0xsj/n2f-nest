import { ok, type Result } from '../../../../shared/errors/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import { normalizeEmail } from '../../domain/index.js';
import type { IdentityMailer } from '../ports/index.js';
import type { IdentityApplicationFailure } from '../failures.js';
import type { IssueVerificationChallenge } from './issue-verification-challenge.js';
import type { RegisterIdentity } from './register-identity.js';

export type SignUpCommand = Readonly<{
  email: unknown;
  password: SecretString;
  work: WorkContext;
  signal?: AbortSignal;
}>;

/**
 * The same for a new and a taken email, so the caller learns nothing about
 * which addresses have accounts. `mailed` is for logs only: whether the
 * message for this outcome was handed to delivery.
 */
export type SignUpResult = Readonly<{ accepted: true; mailed: boolean }>;

export type SignUpDependencies = Readonly<{
  register: Pick<RegisterIdentity, 'execute'>;
  challenges: Pick<IssueVerificationChallenge, 'execute'>;
  mailer: IdentityMailer;
}>;

/**
 * Registration that does not disclose whether an email is taken (hardening
 * item S2). A new email gets an identity and a verification link by mail; a
 * taken one gets a notice to its owner. Both hash the password before storage
 * decides, so both cost the same time, and both answer alike. Only failures
 * that do not depend on existing accounts (an invalid email or password,
 * storage unavailable) are reported.
 */
export class SignUp {
  constructor(private readonly dependencies: SignUpDependencies) {}

  async execute(command: SignUpCommand): Promise<Result<SignUpResult, IdentityApplicationFailure>> {
    const registered = await this.dependencies.register.execute(command);

    if (!registered.ok) {
      if (registered.error.type !== 'identity.email_taken') return registered;
      const to = normalizeEmail(command.email);
      if (!to.ok) return ok({ accepted: true, mailed: false });
      return ok({ accepted: true, mailed: this.dependencies.mailer.sendAccountExists({ to: to.value }).ok });
    }

    // The identity exists from here on. A missing challenge or unsent mail is
    // recovered by resending, so it does not fail (or reveal) the sign-up.
    const to = normalizeEmail(command.email);
    const challenge = await this.dependencies.challenges.execute({
      identityId: registered.value.identityId,
      work: command.work,
      signal: command.signal,
    });
    if (!challenge.ok || !to.ok) return ok({ accepted: true, mailed: false });

    const sent = this.dependencies.mailer.sendVerification({
      to: to.value,
      challengeId: challenge.value.challengeId,
      token: challenge.value.token,
      expiresAt: challenge.value.expiresAt,
    });
    return ok({ accepted: true, mailed: sent.ok });
  }
}
