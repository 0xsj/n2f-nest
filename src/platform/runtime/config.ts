import { Reader, os } from '../../shared/env/index.js';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../shared/errors/index.js';
import { SecretString } from '../../shared/secret/index.js';
import type { Lookup } from '../../shared/env/lookup.js';
import type { Config as NatsConfig } from '../../shared/events/nats/index.js';

export type StorageMode = 'memory' | 'postgres';
/** Deployment environment. Production refuses settings that are only safe locally. */
export type Environment = 'development' | 'test' | 'production';
export type EventTransport = 'local' | 'nats';

/**
 * Express `trust proxy` setting. `false` uses the socket address; a hop count
 * or an address list trusts only the named proxies, so `X-Forwarded-For`
 * cannot be forged by a direct client.
 */
export type TrustProxy = false | number | readonly string[];

export type RuntimeConfig = Readonly<{
  environment: Environment;
  storage: StorageMode;
  eventTransport: EventTransport;
  database:
    | Readonly<{
        url: SecretString;
        maxConnections: number;
        timeoutMs: number;
        /** Budget for applying migrations at startup, including lock waits. */
        migrationTimeoutMs: number;
      }>
    | undefined;
  nats: NatsConfig | undefined;
  http: Readonly<{
    trustProxy: TrustProxy;
    /** Mounts development-only endpoints that disclose secrets or all tenants. */
    devEndpoints: boolean;
    /** Browser origins allowed to call the API; empty denies every cross-origin call. */
    corsOrigins: readonly string[];
    /**
     * Minimum response time of sign-up and verification resend, so how long
     * they take does not reveal whether an account exists.
     */
    signupFloorMs: number;
  }>;
  /** How long sent outbox rows and processed inbox events are kept. */
  eventRetentionHours: number;
  /**
   * How long a stopping process reports not-ready before it closes, so load
   * balancers stop routing to it first.
   */
  shutdownDrainMs: number;
  /** Bearer token required to read /metrics; required in production. */
  metricsToken: SecretString | undefined;
  mail: MailConfig;
}>;

/**
 * Outgoing mail. `capture` keeps messages in process for the development
 * mailbox (`GET /dev/mail`); it would expose verification tokens, so
 * production requires `smtp`.
 */
export type MailConfig = Readonly<{
  transport: 'capture' | 'smtp';
  /** SMTP connection URL (`smtps://user:pass@host:465`); only with `smtp`. */
  smtpUrl: SecretString | undefined;
  /** The From address of every message. */
  from: string;
  /** Base URL of the application links in mail point to (verification). */
  appUrl: string | undefined;
}>;

const PROXY_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** Exact origins (`https://app.example.com`, `http://localhost:7310`); no wildcards. */
function parseOrigins(value: string | undefined): readonly string[] | undefined {
  if (value === undefined || value.trim() === '') return Object.freeze([]);
  const origins = value.split(',').map((entry) => entry.trim());
  const valid = origins.every((origin) => {
    try {
      const url = new URL(origin);
      return (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.origin === origin &&
        url.username === '' &&
        url.password === ''
      );
    } catch {
      return false;
    }
  });
  return valid ? Object.freeze(origins) : undefined;
}

function parseTrustProxy(value: string | undefined): TrustProxy | undefined {
  if (value === undefined || value === 'false') return false;
  if (/^[1-9]$/.test(value)) return Number(value);
  const entries = value.split(',').map((entry) => entry.trim());
  return entries.length > 0 &&
    entries.every(
      (entry) =>
        PROXY_NAMES.has(entry) ||
        /^(?=[0-9A-Fa-f:.]*[:.])[0-9A-Fa-f:.]+(\/[0-9]{1,3})?$/.test(entry),
    )
    ? Object.freeze(entries)
    : undefined;
}

export function parseRuntimeConfig(
  lookup: Lookup,
): Result<RuntimeConfig, Failure> {
  const reader = new Reader(lookup);
  const environment = reader.enumeration('N2F_ENV', 'development', [
    'development',
    'test',
    'production',
  ]) as Environment;
  // N2F_IDENTITY_STORAGE remains a compatibility alias for existing local
  // environments; new deployments use the domain-neutral N2F_STORAGE name.
  const storageKey = lookup('N2F_STORAGE') !== undefined
    ? 'N2F_STORAGE'
    : 'N2F_IDENTITY_STORAGE';
  const storage = reader.enumeration(
    storageKey,
    'memory',
    ['memory', 'postgres'],
  ) as StorageMode;
  const eventTransport = reader.enumeration(
    'N2F_EVENT_TRANSPORT',
    storage === 'postgres' ? 'nats' : 'local',
    ['local', 'nats'],
  ) as EventTransport;

  let database: RuntimeConfig['database'];
  if (storage === 'postgres') {
    database = {
      url: reader.secret('N2F_DATABASE_URL'),
      maxConnections: reader.int('N2F_DATABASE_MAX_CONNECTIONS', 10, 1, 64),
      timeoutMs: reader.int('N2F_DATABASE_TIMEOUT_MS', 5000, 1, 30000),
      migrationTimeoutMs: reader.int('N2F_MIGRATION_TIMEOUT_MS', 120_000, 1000, 3_600_000),
    };
  }

  let nats: RuntimeConfig['nats'];
  if (eventTransport === 'nats') {
    nats = {
      url: reader.secret('N2F_NATS_URL'),
      // The stream name is deployment-owned; n2f_events is the local target.
      stream: reader.string('N2F_NATS_STREAM', 'n2f_events'),
      subjectPrefix: reader.string(
        'N2F_NATS_SUBJECT_PREFIX',
        'n2f.events.',
      ),
      consumer: reader.string('N2F_NATS_CONSUMER', 'audit'),
      timeoutMs: reader.int('N2F_NATS_TIMEOUT_MS', 1000, 1, 5000),
      maxAgeMs: reader.int('N2F_NATS_STREAM_MAX_AGE_HOURS', 168, 1, 8760) * 3_600_000,
      maxBytes: reader.int('N2F_NATS_STREAM_MAX_MB', 64, 1, 1_048_576) * 1024 * 1024,
    };
  }

  const devEndpoints = reader.boolean('N2F_DEV_ENDPOINTS', false);
  const eventRetentionHours = reader.int('N2F_EVENT_RETENTION_HOURS', 168, 1, 8760);
  const shutdownDrainMs = reader.int(
    'N2F_SHUTDOWN_DRAIN_MS',
    environment === 'production' ? 10_000 : 0,
    0,
    120_000,
  );
  const signupFloorMs = reader.int(
    'N2F_SIGNUP_FLOOR_MS',
    environment === 'production' ? 1000 : 0,
    0,
    10_000,
  );
  const metricsTokenValue = lookup('N2F_METRICS_TOKEN');
  const metricsToken =
    metricsTokenValue === undefined || metricsTokenValue === ''
      ? undefined
      : new SecretString(metricsTokenValue);

  const mailTransport = reader.enumeration('N2F_MAIL_TRANSPORT', 'capture', [
    'capture',
    'smtp',
  ]) as MailConfig['transport'];
  const smtpUrl = mailTransport === 'smtp' ? reader.secret('N2F_SMTP_URL') : undefined;
  const mailFrom = reader.string('N2F_MAIL_FROM', 'n2f <no-reply@localhost>');
  const appUrlValue = lookup('N2F_APP_URL');

  const valid = reader.check();
  if (!valid.ok) return err(valid.error);

  const appUrl = parseAppUrl(appUrlValue);
  if (appUrl === null) {
    return err(
      failure('invalid', 'invalid configuration', {
        type: 'env.invalid',
        fields: { N2F_APP_URL: 'invalid_url' },
      }),
    );
  }
  if (smtpUrl !== undefined && !/^smtps?:\/\//.test(smtpUrl.reveal())) {
    return err(
      failure('invalid', 'invalid configuration', {
        type: 'env.invalid',
        fields: { N2F_SMTP_URL: 'must_be_smtp_or_smtps_url' },
      }),
    );
  }
  if (/[\r\n]/.test(mailFrom) || mailFrom.trim() === '') {
    return err(
      failure('invalid', 'invalid configuration', {
        type: 'env.invalid',
        fields: { N2F_MAIL_FROM: 'invalid_address' },
      }),
    );
  }

  const corsOrigins = parseOrigins(lookup('N2F_CORS_ORIGINS'));
  if (corsOrigins === undefined) {
    return err(
      failure('invalid', 'invalid configuration', {
        type: 'env.invalid',
        fields: { N2F_CORS_ORIGINS: 'invalid_origin' },
      }),
    );
  }

  if (metricsToken !== undefined && metricsToken.reveal().length < 32) {
    return err(
      failure('invalid', 'invalid configuration', {
        type: 'env.invalid',
        fields: { N2F_METRICS_TOKEN: 'too_short_min_32' },
      }),
    );
  }

  const trustProxy = parseTrustProxy(lookup('N2F_TRUST_PROXY'));
  if (trustProxy === undefined) {
    return err(
      failure('invalid', 'invalid configuration', {
        type: 'env.invalid',
        fields: { N2F_TRUST_PROXY: 'invalid_trust_proxy' },
      }),
    );
  }

  if (eventTransport === 'nats' && storage !== 'postgres') {
    return err(
      failure(
        'invalid',
        'NATS event transport requires PostgreSQL storage',
        {
          type: 'env.invalid',
          fields: { N2F_EVENT_TRANSPORT: 'requires_postgres' },
        },
      ),
    );
  }

  // Production must not run with settings that are only safe locally: an
  // in-memory store loses every write on restart, and development endpoints
  // disclose verification tokens and every tenant's audit log.
  if (environment === 'production') {
    const unsafe: Record<string, string> = {};
    if (storage !== 'postgres') unsafe.N2F_STORAGE = 'production_requires_postgres';
    if (devEndpoints) unsafe.N2F_DEV_ENDPOINTS = 'forbidden_in_production';
    if (!metricsToken) unsafe.N2F_METRICS_TOKEN = 'required_in_production';
    if (mailTransport !== 'smtp') unsafe.N2F_MAIL_TRANSPORT = 'production_requires_smtp';
    if (appUrl === undefined) unsafe.N2F_APP_URL = 'required_in_production';
    if (Object.keys(unsafe).length > 0) {
      return err(
        failure('invalid', 'unsafe configuration for production', {
          type: 'env.unsafe_for_production',
          fields: unsafe,
        }),
      );
    }
  }

  return ok({
    environment,
    storage,
    eventTransport,
    database,
    nats,
    http: { trustProxy, devEndpoints, corsOrigins, signupFloorMs },
    eventRetentionHours,
    shutdownDrainMs,
    metricsToken,
    mail: Object.freeze({ transport: mailTransport, smtpUrl, from: mailFrom, appUrl }),
  });
}

/** An absolute http(s) URL without credentials, query or fragment; undefined when unset, null when invalid. */
function parseAppUrl(value: string | undefined): string | undefined | null {
  if (value === undefined || value.trim() === '') return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return null;
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function loadRuntimeConfig(): Result<RuntimeConfig, Failure> {
  const source = os();
  return source.ok ? parseRuntimeConfig(source.value) : source;
}

/** A configuration failure as an operator-readable line naming each variable. */
export function describeConfigFailure(error: Failure): string {
  const fields = Object.entries(error.fields ?? {});
  return fields.length === 0
    ? error.message
    : `${error.message}: ${fields.map(([name, problem]) => `${name} (${problem})`).join(', ')}`;
}

export function runtimeConfigOrThrow(): RuntimeConfig {
  const result = loadRuntimeConfig();
  if (result.ok) return result.value;
  throw new Error(describeConfigFailure(result.error));
}
