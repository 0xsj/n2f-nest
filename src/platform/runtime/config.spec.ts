import { describe, expect, it } from 'vitest';
import { map } from '../../shared/env/index.js';
import { parseRuntimeConfig } from './config.js';

describe('runtime configuration', () => {
  it('defaults to self-contained memory mode', () => {
    const result = parseRuntimeConfig(map({}));

    expect(result).toEqual({
      ok: true,
      value: {
        storage: 'memory',
        eventTransport: 'local',
        database: undefined,
        nats: undefined,
      },
    });
  });

  it('requires a database URL when PostgreSQL mode is selected', () => {
    const result = parseRuntimeConfig(
      map({ N2F_STORAGE: 'postgres' }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('env.invalid');
    }
  });

  it('accepts the previous Identity-specific storage key as a compatibility alias', () => {
    const result = parseRuntimeConfig(
      map({
        N2F_IDENTITY_STORAGE: 'postgres',
        N2F_DATABASE_URL: 'postgres://localhost/n2f',
        N2F_EVENT_TRANSPORT: 'local',
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.storage).toBe('postgres');
  });

  it('parses PostgreSQL settings without exposing the URL as ordinary text', () => {
    const result = parseRuntimeConfig(
      map({
        N2F_STORAGE: 'postgres',
        N2F_EVENT_TRANSPORT: 'local',
        N2F_DATABASE_URL: 'postgres://localhost/n2f',
        N2F_DATABASE_MAX_CONNECTIONS: '4',
        N2F_DATABASE_TIMEOUT_MS: '3000',
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.storage).toBe('postgres');
      expect(result.value.eventTransport).toBe('local');
      expect(result.value.database?.maxConnections).toBe(4);
      expect(result.value.database?.timeoutMs).toBe(3000);
      expect(result.value.database?.url.toString()).toBe('[REDACTED]');
      expect(result.value.nats).toBeUndefined();
    }
  });

  it('parses NATS settings for durable PostgreSQL mode', () => {
    const result = parseRuntimeConfig(
      map({
        N2F_STORAGE: 'postgres',
        N2F_EVENT_TRANSPORT: 'nats',
        N2F_DATABASE_URL: 'postgres://localhost/n2f',
        N2F_NATS_URL: 'nats://localhost:4222',
        N2F_NATS_STREAM: 'n2f_events',
        N2F_NATS_SUBJECT_PREFIX: 'n2f.events.',
        N2F_NATS_CONSUMER: 'audit_projection',
        N2F_NATS_TIMEOUT_MS: '2000',
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.eventTransport).toBe('nats');
      expect(result.value.nats?.stream).toBe('n2f_events');
      expect(result.value.nats?.subjectPrefix).toBe('n2f.events.');
      expect(result.value.nats?.consumer).toBe('audit_projection');
      expect(result.value.nats?.timeoutMs).toBe(2000);
      expect(result.value.nats?.url.toString()).toBe('[REDACTED]');
    }
  });

  it('defaults PostgreSQL mode to NATS unless local transport is explicit', () => {
    const result = parseRuntimeConfig(
      map({
        N2F_STORAGE: 'postgres',
        N2F_DATABASE_URL: 'postgres://localhost/n2f',
        N2F_NATS_URL: 'nats://localhost:4222',
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.eventTransport).toBe('nats');
      expect(result.value.nats?.stream).toBe('n2f_events');
      expect(result.value.nats?.subjectPrefix).toBe('n2f.events.');
    }
  });

  it('does not allow NATS without durable Identity storage', () => {
    const result = parseRuntimeConfig(
      map({
        N2F_EVENT_TRANSPORT: 'nats',
        N2F_NATS_URL: 'nats://localhost:4222',
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('env.invalid');
    }
  });
});
