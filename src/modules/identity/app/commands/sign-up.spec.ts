import { describe, expect, it } from 'vitest';
import { err, failure, ok, typedFailure, type Failure, type Result } from '../../../../shared/errors/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import type { IdentityMailer } from '../ports/index.js';
import { SignUp } from './sign-up.js';

const id = (value: string): ID => {
  const parsed = parse(value);
  if (!parsed.ok) throw new Error('fixture');
  return parsed.value;
};
const identityId = id('00000000-0000-7000-8000-000000000001');
const challengeId = id('00000000-0000-7000-8000-000000000002');
const expiresAt = new Date('2026-09-24T00:00:00.000Z');
const command = {
  email: ' Someone@Example.com ',
  password: new SecretString('correct horse battery staple'),
  work: {} as never,
};

function setup(
  registered: Result<unknown, Failure>,
  challenge: Result<unknown, Failure> = ok({ identityId, challengeId, token: new SecretString('t0k'), expiresAt }),
  accepts = true,
) {
  const sent: Array<[string, unknown]> = [];
  const mailer: IdentityMailer = {
    sendVerification: (input) => {
      sent.push(['verification', { ...input, token: input.token.reveal() }]);
      return accepts ? ok(undefined) : err(failure('unavailable', 'full', { type: 'mail.queue_full' }));
    },
    sendAccountExists: (input) => {
      sent.push(['exists', input]);
      return accepts ? ok(undefined) : err(failure('unavailable', 'full', { type: 'mail.queue_full' }));
    },
  };
  const useCase = new SignUp({
    register: { execute: async () => registered as never },
    challenges: { execute: async () => challenge as never },
    mailer,
  });
  return { sent, useCase };
}

describe('SignUp', () => {
  it('mails a verification link to a new address', async () => {
    const { sent, useCase } = setup(ok({ identityId }));

    expect(await useCase.execute(command)).toEqual(ok({ accepted: true, mailed: true }));
    expect(sent).toEqual([
      ['verification', { to: 'someone@example.com', challengeId, token: 't0k', expiresAt }],
    ]);
  });

  it('answers a taken address the same, mailing its owner a notice instead', async () => {
    const { sent, useCase } = setup(
      err(typedFailure('conflict', 'identity.email_taken', 'email is taken')),
    );

    expect(await useCase.execute(command)).toEqual(ok({ accepted: true, mailed: true }));
    expect(sent).toEqual([['exists', { to: 'someone@example.com' }]]);
  });

  it('still accepts when the challenge or the mail cannot be issued, so a resend can recover', async () => {
    const noChallenge = setup(ok({ identityId }), err(failure('unavailable', 'down', { type: 'x' })));
    const noMail = setup(ok({ identityId }), undefined, false);

    expect(await noChallenge.useCase.execute(command)).toEqual(ok({ accepted: true, mailed: false }));
    expect(noChallenge.sent).toEqual([]);
    expect(await noMail.useCase.execute(command)).toEqual(ok({ accepted: true, mailed: false }));
  });

  it('reports failures that do not depend on existing accounts', async () => {
    const invalid = typedFailure('invalid', 'identity.password_too_short', 'short');
    const { sent, useCase } = setup(err(invalid));

    expect(await useCase.execute(command)).toEqual(err(invalid));
    expect(sent).toEqual([]);
  });
});
