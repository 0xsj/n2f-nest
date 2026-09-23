import { describe, expect, it } from 'vitest';
import { ok } from '../../../shared/errors/index.js';
import { parse, type ID } from '../../../shared/id/index.js';
import { SecretString } from '../../../shared/secret/index.js';
import type { MailMessage } from '../../../platform/mail/index.js';
import type { EmailAddress } from '../domain/index.js';
import { PlatformIdentityMailer } from './mail.js';

const challengeId = (() => {
  const parsed = parse('00000000-0000-7000-8000-000000000002');
  if (!parsed.ok) throw new Error('fixture');
  return parsed.value as ID;
})();
const to = 'someone@example.com' as EmailAddress;

function capture(appUrl?: string) {
  const messages: MailMessage[] = [];
  const mailer = new PlatformIdentityMailer({ send: (message) => (messages.push(message), ok(undefined)) }, appUrl);
  return { messages, mailer };
}

describe('PlatformIdentityMailer', () => {
  it('links to the application with the challenge and an encoded token', () => {
    const { messages, mailer } = capture('https://app.example.com');

    mailer.sendVerification({
      to,
      challengeId,
      token: new SecretString('a+b/c='),
      expiresAt: new Date('2026-09-24T00:00:00.000Z'),
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]!.to).toBe(to);
    const link = messages[0]!.text.match(/https:\/\/app\.example\.com\/verify\?(\S+)/)?.[1];
    const query = new URLSearchParams(link);
    expect(query.get('challenge')).toBe(challengeId);
    expect(query.get('token')).toBe('a+b/c=');
    expect(messages[0]!.text).toContain('2026-09-24T00:00:00.000Z');
  });

  it('sends the existing owner a notice with no link or token', () => {
    const { messages, mailer } = capture('https://app.example.com');

    mailer.sendAccountExists({ to });

    expect(messages[0]!.to).toBe(to);
    expect(messages[0]!.text).not.toMatch(/verify\?|token/);
  });
});
