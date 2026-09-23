import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { SecretString } from '../../shared/secret/index.js';
import type { RuntimeConfig } from '../runtime/config.js';
import { CaptureMailer } from './capture-mailer.js';
import { DevMailController } from './mail.controller.js';
import { validMessage } from './mailer.js';
import { SmtpMailer } from './smtp-mailer.js';

const message = { to: 'someone@example.com', subject: 'Hello', text: 'Body' };

describe('validMessage', () => {
  it.each([
    ['a header injected through the recipient', { ...message, to: 'a@example.com\r\nBcc: b@example.com' }],
    ['a list of recipients', { ...message, to: 'a@example.com, b@example.com' }],
    ['a display name', { ...message, to: 'A <a@example.com>' }],
    ['a header injected through the subject', { ...message, subject: 'Hi\r\nBcc: b@example.com' }],
    ['an oversized body', { ...message, text: 'x'.repeat(20_001) }],
  ])('refuses %s', (_label, candidate) => {
    expect(validMessage(candidate)).toBe(false);
  });

  it('accepts a single plain address', () => {
    expect(validMessage(message)).toBe(true);
  });
});

describe('CaptureMailer', () => {
  it('keeps messages per recipient, newest first, matching the address case-insensitively', () => {
    const mailer = new CaptureMailer();
    mailer.send({ ...message, subject: 'first' });
    mailer.send({ ...message, to: 'other@example.com' });
    mailer.send({ ...message, subject: 'second' });

    expect(mailer.to('Someone@Example.com').map((captured) => captured.subject)).toEqual(['second', 'first']);
  });

  it('refuses an invalid message without keeping it', () => {
    const mailer = new CaptureMailer();

    expect(mailer.send({ ...message, to: 'nobody' })).toMatchObject({ ok: false, error: { type: 'mail.invalid_message' } });
    expect(mailer.to('nobody')).toEqual([]);
  });
});

describe('DevMailController', () => {
  const config = (devEndpoints: boolean) => ({ http: { devEndpoints } }) as RuntimeConfig;

  it('serves captured mail only with development endpoints', () => {
    const mailer = new CaptureMailer();
    mailer.send(message);

    expect(new DevMailController(mailer, config(true)).read(message.to)).toHaveLength(1);
    expect(() => new DevMailController(mailer, config(false)).read(message.to)).toThrow(HttpException);
  });

  it('serves nothing when mail really goes out', async () => {
    const smtp = new SmtpMailer(new SecretString('smtp://127.0.0.1:9'), 'n2f <no-reply@localhost>', 0);
    try {
      expect(() => new DevMailController(smtp, config(true)).read(message.to)).toThrow(HttpException);
    } finally {
      await smtp.onModuleDestroy();
    }
  });
});

describe('SmtpMailer', () => {
  it('accepts a valid message without waiting for delivery, and refuses once stopping', async () => {
    const smtp = new SmtpMailer(new SecretString('smtp://127.0.0.1:9'), 'n2f <no-reply@localhost>', 0);
    const started = Date.now();

    expect(smtp.send(message).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(50);
    expect(smtp.send({ ...message, to: 'nobody' }).ok).toBe(false);

    await smtp.onModuleDestroy();
    expect(smtp.send(message)).toMatchObject({ ok: false, error: { type: 'mail.queue_full' } });
  });
});
