import type { Failure, Result } from '../../../shared/errors/index.js';
import type { ID } from '../../../shared/id/index.js';
import type { SecretString } from '../../../shared/secret/index.js';
import type { Mailer } from '../../../platform/mail/index.js';
import type { IdentityMailer } from '../app/ports/index.js';
import type { EmailAddress } from '../domain/index.js';

/**
 * Identity's messages, sent through the platform mailer. The verification
 * link is `<N2F_APP_URL>/verify?challenge=…&token=…`; the application page it
 * opens posts both values to `POST /identity/verify`.
 */
export class PlatformIdentityMailer implements IdentityMailer {
  constructor(
    private readonly mailer: Mailer,
    private readonly appUrl: string | undefined,
  ) {}

  sendVerification(
    input: Readonly<{ to: EmailAddress; challengeId: ID; token: SecretString; expiresAt: Date }>,
  ): Result<void, Failure> {
    const query = new URLSearchParams({ challenge: input.challengeId, token: input.token.reveal() });
    const link = `${this.appUrl ?? ''}/verify?${query.toString()}`;
    return this.mailer.send({
      to: input.to,
      subject: 'Confirm your email address',
      text: [
        'Confirm your email address to finish signing up:',
        '',
        link,
        '',
        `This link expires at ${input.expiresAt.toISOString()}.`,
        'If you did not sign up, ignore this message.',
      ].join('\n'),
    });
  }

  sendPasswordReset(
    input: Readonly<{ to: EmailAddress; challengeId: ID; token: SecretString; expiresAt: Date }>,
  ): Result<void, Failure> {
    const query = new URLSearchParams({ challenge: input.challengeId, token: input.token.reveal() });
    const link = `${this.appUrl ?? ''}/reset-password?${query.toString()}`;
    return this.mailer.send({
      to: input.to,
      subject: 'Reset your password',
      text: [
        'Someone asked to reset the password for this email address. To choose a new one:',
        '',
        link,
        '',
        `This link expires at ${input.expiresAt.toISOString()} and works once.`,
        'Resetting signs out every session. If you did not ask for this, ignore this message.',
      ].join('\n'),
    });
  }

  sendAccountExists(input: Readonly<{ to: EmailAddress }>): Result<void, Failure> {
    return this.mailer.send({
      to: input.to,
      subject: 'Sign-up attempt for your account',
      text: [
        'Someone tried to sign up with this email address, which already has an account.',
        '',
        'If it was you, sign in instead, or reset your password if you have lost it.',
        'If it was not, you can ignore this message; nothing about your account has changed.',
      ].join('\n'),
    });
  }
}
