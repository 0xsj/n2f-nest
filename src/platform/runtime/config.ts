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
export type EventTransport = 'local' | 'nats';

export type RuntimeConfig = Readonly<{
  storage: StorageMode;
  eventTransport: EventTransport;
  database:
    | Readonly<{
        url: SecretString;
        maxConnections: number;
        timeoutMs: number;
      }>
    | undefined;
  nats: NatsConfig | undefined;
}>;

export function parseRuntimeConfig(
  lookup: Lookup,
): Result<RuntimeConfig, Failure> {
  const reader = new Reader(lookup);
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
    };
  }

  const valid = reader.check();
  if (!valid.ok) return err(valid.error);

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

  return ok({ storage, eventTransport, database, nats });
}

export function loadRuntimeConfig(): Result<RuntimeConfig, Failure> {
  const source = os();
  return source.ok ? parseRuntimeConfig(source.value) : source;
}

export function runtimeConfigOrThrow(): RuntimeConfig {
  const result = loadRuntimeConfig();
  if (result.ok) return result.value;
  throw new Error(result.error.message);
}
