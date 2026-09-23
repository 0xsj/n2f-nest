import { describe, expect, it } from 'vitest';
import { err, failure, ok } from '../../../../shared/errors/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import type { CredentialAuthenticatorReader, IdentityMailer } from '../ports/index.js';
import { ResendVerification } from './resend-verification.js';

const id = (value: string): ID => {
  const parsed = parse(value);
  if (!parsed.ok) throw new Error('fixture');
  return parsed.value;
};
const identityId = id('00000000-0000-7000-8000-000000000001');
const challengeId = id('00000000-0000-7000-8000-000000000002');
const expiresAt = new Date('2026-09-24T00:00:00.000Z');

function setup(status: 'pending_verification' | 'active' | null) {
  const sent: unknown[] = [];
  let issued = 0;
  const credentials: CredentialAuthenticatorReader = {
    findByEmail: async () =>
      ok(status === null ? null : ({ identity: { id: identityId, status } } as never)),
  };
  const mailer: IdentityMailer = {
    sendVerification: (input) => {
      sent.push({ ...input, token: input.token.reveal() });
      return ok(undefined);
    },
    sendAccountExists: () => ok(undefined),
  };
  const useCase = new ResendVerification({
    credentials,
    challenges: {
      execute: async () => {
        issued += 1;
        return ok({ identityId, challengeId, token: new SecretString('fresh'), expiresAt });
      },
    },
    mailer,
  });
  return { sent, useCase, issued: () => issued };
}

const command = { email: 'Someone@Example.com', work: {} as never };

describe('ResendVerification', () => {
  it('mails a fresh link to an address awaiting verification', async () => {
    const { sent, useCase } = setup('pending_verification');

    expect(await useCase.execute(command)).toEqual(ok({ accepted: true, mailed: true }));
    expect(sent).toEqual([{ to: 'someone@example.com', challengeId, token: 'fresh', expiresAt }]);
  });

  it.each([['unknown', null], ['verified', 'active']] as const)(
    'answers an %s address alike without issuing or mailing anything',
    async (_label, status) => {
      const { sent, useCase, issued } = setup(status);

      expect(await useCase.execute(command)).toEqual(ok({ accepted: true, mailed: false }));
      expect(sent).toEqual([]);
      expect(issued()).toBe(0);
    },
  );

  it('refuses an invalid email and reports storage failures', async () => {
    expect(await setup(null).useCase.execute({ ...command, email: 'not-an-email' })).toMatchObject({
      ok: false,
      error: { type: 'credential.invalid_email' },
    });
    const broken = new ResendVerification({
      credentials: { findByEmail: async () => err(failure('unavailable', 'down', { type: 'postgres.unavailable' })) },
      challenges: { execute: async () => ok({}) as never },
      mailer: { sendVerification: () => ok(undefined), sendAccountExists: () => ok(undefined) },
    });
    expect(await broken.execute(command)).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
  });
});
