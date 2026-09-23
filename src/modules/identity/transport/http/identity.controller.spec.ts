import { describe, expect, it, vi } from 'vitest';
import { ok } from '../../../../shared/errors/index.js';
import type { ResendVerification, SignUp } from '../../app/index.js';
import { IdentityController } from './identity.controller.js';
import type { IdentityHttpWork } from './work.js';

function controller(mailed: boolean, signupFloorMs = 0) {
  const signUp = { execute: vi.fn(async () => ok({ accepted: true as const, mailed })) };
  const resend = { execute: vi.fn(async () => ok({ accepted: true as const, mailed })) };
  const work = { open: () => ok({}) } as unknown as IdentityHttpWork;
  const none = undefined as never;
  return new IdentityController(
    signUp as unknown as SignUp,
    resend as unknown as ResendVerification,
    none,
    none,
    none,
    none,
    work,
    { http: { signupFloorMs } } as never,
  );
}

describe('IdentityController sign-up and resend (hardening item S2)', () => {
  it('answers sign-up the same whether or not a message went out, disclosing nothing', async () => {
    const body = { email: 'someone@example.com', password: 'correct horse battery staple' };

    const sent = await controller(true).registerIdentity(body);
    const unsent = await controller(false).registerIdentity(body);

    expect(sent).toEqual(unsent);
    expect(Object.keys(sent).sort()).toEqual(['detail', 'status']);
  });

  it('answers resend the same whether or not a message went out', async () => {
    const sent = await controller(true).resendVerification({ email: 'someone@example.com' });
    const unsent = await controller(false).resendVerification({ email: 'someone@example.com' });

    expect(sent).toEqual(unsent);
  });

  it('refuses a resend body that names an identity instead of an email', async () => {
    await expect(
      controller(true).resendVerification({ identityId: '00000000-0000-7000-8000-000000000001' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('holds both answers to the configured floor, however quickly the work finished', async () => {
    const started = performance.now();
    await controller(true, 120).registerIdentity({ email: 'someone@example.com', password: 'x'.repeat(20) });
    const signUp = performance.now() - started;
    const resendStarted = performance.now();
    await controller(false, 120).resendVerification({ email: 'someone@example.com' });
    const resend = performance.now() - resendStarted;

    expect(signUp).toBeGreaterThanOrEqual(115);
    expect(resend).toBeGreaterThanOrEqual(115);
  });
});
