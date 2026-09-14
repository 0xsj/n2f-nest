/**
 * Identity SMTP mail delivery (CONTRACT.md M10–M16). Builds the verification and
 * reset messages and submits them over SMTP with nodemailer, which is confined
 * to this directory. Delivery is a value: the adapter never throws into the
 * application, never retries, and logs one safe event per attempt.
 * @module modules/identity/infra/smtp
 */
import { inspect } from 'node:util';
import nodemailer from 'nodemailer';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type { Logger } from '../../../../shared/logger/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import type { MailDelivery } from '../../app/command/index.js';
import { Email } from '../../domain/email.js';

export type Security = 'none' | 'starttls' | 'tls';
export type MailerConfig = Readonly<{
  host: string;
  port: number;
  security: Security;
  username?: string;
  password?: SecretString;
  from: string;
  fromName?: string;
  linkOrigin: string;
  verifyPath?: string;
  resetPath?: string;
  timeoutMs?: number;
}>;
type Kind = 'verification' | 'reset';
type Outcome = 'delivered' | 'refused' | 'timeout' | 'failed';
type Settings = Readonly<{
  host: string;
  port: number;
  security: Security;
  credentials?: Readonly<{ username: string; password: SecretString }>;
  from: string;
  fromName: string;
  linkOrigin: string;
  verifyPath: string;
  resetPath: string;
  timeoutMs: number;
}>;

const invalid = (field: string): Failure =>
  failure('invalid', 'invalid mail configuration', {
    type: 'identity.mail_configuration',
    fields: { [field]: 'invalid' },
  });
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const isLoopback = (host: string): boolean =>
  LOOPBACK.has(host.toLowerCase()) ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

function validate(c: MailerConfig): Result<Settings, Failure> {
  if (
    typeof c.host !== 'string' ||
    c.host.length < 1 ||
    c.host.length > 253 ||
    !/^[A-Za-z0-9.:[\]-]+$/.test(c.host)
  )
    return err(invalid('host'));
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535)
    return err(invalid('port'));
  if (
    c.security !== 'none' &&
    c.security !== 'starttls' &&
    c.security !== 'tls'
  )
    return err(invalid('security'));
  if ((c.username === undefined) !== (c.password === undefined))
    return err(invalid('credentials'));
  let credentials: Settings['credentials'];
  if (c.username !== undefined) {
    if (
      typeof c.username !== 'string' ||
      !/^[\x21-\x7e]{1,256}$/.test(c.username) ||
      !(c.password instanceof SecretString) ||
      c.password.reveal() === ''
    )
      return err(invalid('credentials'));
    credentials = { username: c.username, password: c.password };
  }
  // Plaintext SMTP, and therefore plaintext credentials, only on loopback.
  if (c.security === 'none' && !isLoopback(c.host))
    return err(invalid('security'));
  if (typeof c.from !== 'string' || !Email.parse(c.from).ok)
    return err(invalid('from'));
  const fromName = c.fromName ?? 'n2f';
  if (
    typeof fromName !== 'string' ||
    !/^[\x20-\x7e]{1,64}$/.test(fromName) ||
    /["<>\\]/.test(fromName)
  )
    return err(invalid('from_name'));
  let origin: URL;
  try {
    origin = new URL(c.linkOrigin);
  } catch {
    return err(invalid('link_origin'));
  }
  if (
    origin.origin !== c.linkOrigin ||
    !(
      origin.protocol === 'https:' ||
      (origin.protocol === 'http:' && isLoopback(origin.hostname))
    )
  )
    return err(invalid('link_origin'));
  const verifyPath = c.verifyPath ?? '/verify-email';
  const resetPath = c.resetPath ?? '/reset-password';
  for (const [field, path] of [
    ['verify_path', verifyPath],
    ['reset_path', resetPath],
  ] as const)
    if (
      typeof path !== 'string' ||
      !/^\/[\x21-\x7e]{0,255}$/.test(path) ||
      /[?#]/.test(path)
    )
      return err(invalid(field));
  const timeoutMs = c.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    return err(invalid('timeout_ms'));
  return ok({
    host: c.host,
    port: c.port,
    security: c.security,
    ...(credentials ? { credentials } : {}),
    from: c.from,
    fromName,
    linkOrigin: c.linkOrigin,
    verifyPath,
    resetPath,
    timeoutMs,
  });
}

const SUBJECT: Readonly<Record<Kind, string>> = {
  verification: 'Verify your email address',
  reset: 'Reset your password',
};
const PURPOSE: Readonly<Record<Kind, string>> = {
  verification: 'Confirm your email address by opening this link:',
  reset: 'Choose a new password by opening this link:',
};
const IGNORE: Readonly<Record<Kind, string>> = {
  verification:
    'If you did not create an account, you can ignore this message.',
  reset:
    'If you did not ask to reset your password, you can ignore this message.',
};
const body = (kind: Kind, link: string, expiresAt: string): string =>
  [
    PURPOSE[kind],
    '',
    link,
    '',
    `This link expires at ${expiresAt}.`,
    IGNORE[kind],
    '',
  ].join('\n');

/** SMTP replies are refusals, timeouts are timeouts, anything else failed. */
const classify = (e: unknown): Outcome => {
  if (e !== null && typeof e === 'object') {
    const { code, responseCode } = e as {
      code?: unknown;
      responseCode?: unknown;
    };
    if (code === 'ETIMEDOUT') return 'timeout';
    if (typeof responseCode === 'number') return 'refused';
  }
  return 'failed';
};

class SmtpMailer implements MailDelivery {
  readonly #settings: Settings;
  readonly #log: Logger;
  readonly #budget: number;
  constructor(settings: Settings, log: Logger) {
    this.#settings = settings;
    this.#log = log;
    this.#budget = settings.timeoutMs;
    Object.freeze(this);
  }
  sendVerification(
    to: Email,
    token: SecretString,
    expiresAtMs: number,
  ): Promise<boolean> {
    return this.#send('verification', to, token, expiresAtMs);
  }
  sendReset(
    to: Email,
    token: SecretString,
    expiresAtMs: number,
  ): Promise<boolean> {
    return this.#send('reset', to, token, expiresAtMs);
  }
  async #send(
    kind: Kind,
    to: Email,
    token: SecretString,
    expiresAtMs: number,
  ): Promise<boolean> {
    const started = performance.now();
    let outcome: Outcome;
    try {
      outcome = await this.#attempt(kind, to, token, expiresAtMs);
    } catch {
      outcome = 'failed';
    }
    const fields = {
      kind,
      outcome,
      elapsed_ms: Math.round(performance.now() - started),
    };
    if (outcome === 'delivered')
      this.#log.info('identity.mail.attempted', fields);
    else this.#log.warn('identity.mail.attempted', fields);
    return outcome === 'delivered';
  }
  #attempt(
    kind: Kind,
    to: Email,
    token: SecretString,
    expiresAtMs: number,
  ): Promise<Outcome> {
    const s = this.#settings;
    const expires = new Date(expiresAtMs);
    if (
      !(to instanceof Email) ||
      !(token instanceof SecretString) ||
      Number.isNaN(expires.getTime())
    )
      return Promise.resolve('failed');
    const link =
      s.linkOrigin +
      (kind === 'reset' ? s.resetPath : s.verifyPath) +
      '#token=' +
      token.reveal();
    const text = body(kind, link, expires.toISOString());
    // One transport per message: one connection, and the password is handed to
    // the library only for this attempt.
    const transport = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.security === 'tls',
      requireTLS: s.security === 'starttls',
      ignoreTLS: s.security === 'none',
      ...(s.credentials
        ? {
            auth: {
              user: s.credentials.username,
              pass: s.credentials.password.reveal(),
            },
          }
        : {}),
      connectionTimeout: this.#budget,
      greetingTimeout: this.#budget,
      socketTimeout: this.#budget,
      dnsTimeout: this.#budget,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    });
    return new Promise<Outcome>((resolve) => {
      let settled = false;
      const finish = (outcome: Outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        transport.close();
        resolve(outcome);
      };
      const timer = setTimeout(() => finish('timeout'), this.#budget);
      transport
        .sendMail({
          from: { name: s.fromName, address: s.from },
          to: to.reveal(),
          subject: SUBJECT[kind],
          text,
        })
        .then(
          () => finish('delivered'),
          (e: unknown) => finish(classify(e)),
        );
    });
  }
  toString(): string {
    return 'SmtpMailer';
  }
  toJSON(): { delivery: 'smtp' } {
    return { delivery: 'smtp' };
  }
  [inspect.custom](): string {
    return 'SmtpMailer';
  }
}

/** Validates configuration once (M10); root supplies the process logger. */
export function createMailer(
  config: MailerConfig,
  log: Logger,
): Result<MailDelivery, Failure> {
  const settings = validate(config);
  return settings.ok ? ok(new SmtpMailer(settings.value, log)) : settings;
}
