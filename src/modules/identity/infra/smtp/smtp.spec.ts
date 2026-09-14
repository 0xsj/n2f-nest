import { createServer, type AddressInfo, type Socket } from 'node:net';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Failure, Result } from '../../../../shared/errors/index.js';
import { create as createLogger } from '../../../../shared/logger/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import { Email } from '../../domain/email.js';
import { createMailer, type MailerConfig } from './index.js';

const value = <T>(r: Result<T, Failure>): T => {
  if (!r.ok) throw new Error('expected success: ' + r.error.type);
  return r.value;
};
const refused = <T>(r: Result<T, Failure>): Failure => {
  if (r.ok) throw new Error('expected failure');
  return r.error;
};

type Mode = 'accept' | 'reject' | 'stall';
type Captured = { mailFrom: string[]; rcpt: string[]; data: string[] };

/** A minimal scripted SMTP peer: accept, reject at the end of DATA, or never greet. */
async function fakeSmtp(mode: Mode) {
  const captured: Captured = { mailFrom: [], rcpt: [], data: [] };
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    if (mode === 'stall') return;
    socket.setEncoding('utf8');
    const reply = (text: string) => socket.write(text + '\r\n');
    let buffer = '';
    let inData = false;
    reply('220 fake.local ESMTP');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let progress = true;
      while (progress) {
        progress = false;
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end >= 0) {
            captured.data.push(buffer.slice(0, end + 2));
            buffer = buffer.slice(end + 5);
            inData = false;
            reply(
              mode === 'reject'
                ? '550 5.7.1 message rejected'
                : '250 2.0.0 queued',
            );
            progress = true;
          }
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        progress = true;
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO')
          reply('250-fake.local\r\n250-8BITMIME\r\n250 SMTPUTF8');
        else if (verb === 'MAIL') {
          captured.mailFrom.push(line);
          reply('250 2.1.0 ok');
        } else if (verb === 'RCPT') {
          captured.rcpt.push(line);
          reply('250 2.1.5 ok');
        } else if (verb === 'DATA') {
          inData = true;
          reply('354 end data with <CR><LF>.<CR><LF>');
        } else if (verb === 'QUIT') {
          reply('221 2.0.0 bye');
          socket.end();
        } else if (verb === 'RSET' || verb === 'NOOP') reply('250 2.0.0 ok');
        else reply('502 5.5.2 unrecognized');
      }
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const port = (server.address() as AddressInfo).port;
  const close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return { port, captured, close };
}
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
function logs() {
  const lines: string[] = [];
  const runtime = value(
    createLogger({
      format: 'json',
      level: 'debug',
      color: 'never',
      resource: { name: 'smtp-spec' },
      clock: { now: () => new Date(0) },
      sink: {
        write: (s: string) => {
          lines.push(s);
        },
      },
    }),
  );
  return {
    log: runtime.log,
    records: async () => {
      await runtime.close(1000);
      return lines
        .join('')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => ({ raw: l, record: JSON.parse(l) as unknown }));
    },
  };
}
/** Undo SMTP dot-stuffing and the declared transfer encoding. */
function parseMessage(raw: string) {
  const unstuffed = raw.replace(/\r\n\.\./g, '\r\n.');
  const split = unstuffed.indexOf('\r\n\r\n');
  const head = unstuffed.slice(0, split).replace(/\r\n[ \t]+/g, ' ');
  let body = unstuffed.slice(split + 4);
  const headers = new Map<string, string[]>();
  for (const line of head.split('\r\n')) {
    const i = line.indexOf(':');
    const key = line.slice(0, i).toLowerCase();
    headers.set(key, [...(headers.get(key) ?? []), line.slice(i + 1).trim()]);
  }
  const encoding = (
    headers.get('content-transfer-encoding')?.[0] ?? '7bit'
  ).toLowerCase();
  if (encoding === 'quoted-printable')
    body = Buffer.from(
      body
        .replace(/=\r\n/g, '')
        .replace(/=([0-9A-F]{2})/gi, (_, h: string) =>
          String.fromCharCode(parseInt(h, 16)),
        ),
      'latin1',
    ).toString('utf8');
  else if (encoding === 'base64')
    body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  return { headers, body };
}
const attempts = (records: { record: unknown }[]) =>
  records.filter((r) =>
    JSON.stringify(r.record).includes('identity.mail.attempted'),
  );

const TOKEN = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const EXPIRES = Date.UTC(2026, 8, 13, 10, 0, 0);
const recipient = () => value(Email.parse('ada@example.com'));
const config = (
  port: number,
  extra: Partial<MailerConfig> = {},
): MailerConfig => ({
  host: '127.0.0.1',
  port,
  security: 'none',
  from: 'no-reply@n2f.local',
  linkOrigin: 'https://app.example.com',
  timeoutMs: 1000,
  ...extra,
});
const privates = [
  TOKEN,
  'ada@example.com',
  'app.example.com',
  'no-reply@n2f.local',
];

describe('SMTP mail delivery (M10–M16)', () => {
  it('builds one plain-text verification message with the token only in the link fragment (M11, M13)', async () => {
    const smtp = await fakeSmtp('accept');
    const l = logs();
    try {
      const mailer = value(createMailer(config(smtp.port), l.log));
      expect(
        await mailer.sendVerification(
          recipient(),
          new SecretString(TOKEN),
          EXPIRES,
        ),
      ).toBe(true);
      expect(smtp.captured.rcpt).toHaveLength(1);
      expect(smtp.captured.rcpt[0]).toContain('<ada@example.com>');
      expect(smtp.captured.mailFrom[0]).toContain('<no-reply@n2f.local>');
      expect(smtp.captured.data).toHaveLength(1);
      const raw = smtp.captured.data[0];
      const { headers, body } = parseMessage(raw);
      expect(headers.get('subject')).toEqual(['Verify your email address']);
      expect(headers.get('to')?.[0]).toContain('ada@example.com');
      expect(headers.get('from')?.[0]).toContain('n2f');
      expect(headers.get('from')?.[0]).toContain('no-reply@n2f.local');
      expect(headers.has('cc')).toBe(false);
      expect(headers.has('bcc')).toBe(false);
      expect(headers.get('content-type')?.[0].toLowerCase()).toMatch(
        /^text\/plain;.*charset=utf-8/,
      );
      expect(raw.toLowerCase()).not.toContain('text/html');
      expect(body).toContain(
        `https://app.example.com/verify-email#token=${TOKEN}`,
      );
      expect(body).not.toMatch(/\?[^\s]*token/);
      expect(body.split(TOKEN)).toHaveLength(2);
      expect(body).toContain(new Date(EXPIRES).toISOString());
      const logged = attempts(await l.records());
      expect(logged).toHaveLength(1);
      const text = JSON.stringify(logged[0].record);
      expect(text).toContain('"verification"');
      expect(text).toContain('"delivered"');
      expect(text).toMatch(/"elapsed_ms":\d/);
      for (const secret of privates) expect(text, secret).not.toContain(secret);
    } finally {
      await smtp.close();
    }
  });
  it('builds the reset message with its own subject and configurable path (M10, M11)', async () => {
    const smtp = await fakeSmtp('accept');
    const l = logs();
    try {
      const mailer = value(
        createMailer(config(smtp.port, { resetPath: '/account/reset' }), l.log),
      );
      expect(
        await mailer.sendReset(recipient(), new SecretString(TOKEN), EXPIRES),
      ).toBe(true);
      const { headers, body } = parseMessage(smtp.captured.data[0]);
      expect(headers.get('subject')).toEqual(['Reset your password']);
      expect(body).toContain(
        `https://app.example.com/account/reset#token=${TOKEN}`,
      );
      expect(body).toContain(new Date(EXPIRES).toISOString());
      const text = JSON.stringify(attempts(await l.records())[0].record);
      expect(text).toContain('"reset"');
    } finally {
      await smtp.close();
    }
  });
  it('reports a 5xx rejection as not delivered and never as an error (M12)', async () => {
    const smtp = await fakeSmtp('reject');
    const l = logs();
    try {
      const mailer = value(createMailer(config(smtp.port), l.log));
      await expect(
        mailer.sendVerification(recipient(), new SecretString(TOKEN), EXPIRES),
      ).resolves.toBe(false);
      const logged = await l.records();
      const text = JSON.stringify(attempts(logged)[0].record);
      expect(text).toContain('"refused"');
      const all = logged.map((r) => r.raw).join('\n');
      for (const secret of privates) expect(all, secret).not.toContain(secret);
      expect(all).not.toContain('550');
    } finally {
      await smtp.close();
    }
  });
  it('reports a refused connection as not delivered (M12)', async () => {
    const l = logs();
    const mailer = value(createMailer(config(await closedPort()), l.log));
    await expect(
      mailer.sendReset(recipient(), new SecretString(TOKEN), EXPIRES),
    ).resolves.toBe(false);
    const text = JSON.stringify(attempts(await l.records())[0].record);
    expect(text).toContain('"failed"');
  });
  it(
    'bounds a stalled server by the configured timeout (M12)',
    { timeout: 10_000 },
    async () => {
      const smtp = await fakeSmtp('stall');
      const l = logs();
      try {
        const mailer = value(
          createMailer(config(smtp.port, { timeoutMs: 300 }), l.log),
        );
        const started = Date.now();
        await expect(
          mailer.sendVerification(
            recipient(),
            new SecretString(TOKEN),
            EXPIRES,
          ),
        ).resolves.toBe(false);
        expect(Date.now() - started).toBeLessThan(2000);
        const text = JSON.stringify(attempts(await l.records())[0].record);
        expect(text).toContain('"timeout"');
      } finally {
        await smtp.close();
      }
    },
  );
  it('refuses unsafe or malformed configuration (M10)', () => {
    const l = logs();
    const bad: Partial<MailerConfig>[] = [
      { host: '' },
      { host: 'smtp.example.com', security: 'none' },
      {
        host: 'smtp.example.com',
        security: 'none',
        username: 'user',
        password: new SecretString('pw'),
      },
      { port: 0 },
      { port: 65536 },
      { security: 'plain' as never },
      { username: 'user' },
      { password: new SecretString('pw') },
      { from: 'not-an-email' },
      { fromName: 'n2f <admin>' },
      { fromName: 'x'.repeat(65) },
      { linkOrigin: 'http://app.example.com' },
      { linkOrigin: 'https://app.example.com/path' },
      { linkOrigin: 'https://app.example.com/?q=1' },
      { linkOrigin: 'ftp://app.example.com' },
      { verifyPath: 'verify-email' },
      { verifyPath: '/verify#x' },
      { resetPath: '/reset?x=1' },
      { timeoutMs: 0 },
      { timeoutMs: 30_001 },
    ];
    for (const extra of bad)
      expect(
        refused(createMailer(config(25, extra), l.log)).type,
        JSON.stringify(extra),
      ).toBe('identity.mail_configuration');
    const good: Partial<MailerConfig>[] = [
      {},
      { username: 'user', password: new SecretString('pw') },
      { linkOrigin: 'http://127.0.0.1:3000' },
      { host: 'smtp.example.com', security: 'starttls', port: 587 },
      {
        host: 'smtp.example.com',
        security: 'tls',
        port: 465,
        username: 'user',
        password: new SecretString('pw'),
      },
    ];
    for (const extra of good)
      expect(
        createMailer(config(25, extra), l.log).ok,
        JSON.stringify(extra),
      ).toBe(true);
  });
  it('never presents the SMTP password (M14)', () => {
    const l = logs();
    const mailer = value(
      createMailer(
        config(25, {
          username: 'user',
          password: new SecretString('smtp-password-SENTINEL'),
        }),
        l.log,
      ),
    );
    for (const shown of [
      String(mailer),
      JSON.stringify(mailer),
      inspect(mailer, { depth: 5 }),
    ])
      expect(shown).not.toContain('SENTINEL');
  });
});
