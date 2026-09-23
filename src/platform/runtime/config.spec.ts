import { describe, expect, it } from 'vitest';
import { map } from '../../shared/env/index.js';
import { describeConfigFailure, parseRuntimeConfig } from './config.js';

describe('runtime configuration', () => {
  it('defaults to self-contained memory mode', () => {
    const result = parseRuntimeConfig(map({}));

    expect(result).toEqual({
      ok: true,
      value: {
        environment: 'development',
        storage: 'memory',
        eventTransport: 'local',
        database: undefined,
        nats: undefined,
        http: { trustProxy: false, devEndpoints: false, corsOrigins: [], signupFloorMs: 0 },
        eventRetentionHours: 168,
        shutdownDrainMs: 0,
        metricsToken: undefined,
        mail: {
          transport: 'capture',
          smtpUrl: undefined,
          from: 'n2f <no-reply@localhost>',
          appUrl: undefined,
        },
      },
    });
  });

  it('reads the SMTP transport, sender and application URL', () => {
    const result = parseRuntimeConfig(
      map({
        N2F_MAIL_TRANSPORT: 'smtp',
        N2F_SMTP_URL: 'smtps://user:secret@mail.example.com:465',
        N2F_MAIL_FROM: 'Example <no-reply@example.com>',
        N2F_APP_URL: 'https://app.example.com/',
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mail).toMatchObject({
      transport: 'smtp',
      from: 'Example <no-reply@example.com>',
      appUrl: 'https://app.example.com',
    });
    expect(result.value.mail.smtpUrl?.reveal()).toBe('smtps://user:secret@mail.example.com:465');
  });

  it.each([
    [{ N2F_MAIL_TRANSPORT: 'smtp' }, 'N2F_SMTP_URL'],
    [{ N2F_MAIL_TRANSPORT: 'smtp', N2F_SMTP_URL: 'https://mail.example.com' }, 'N2F_SMTP_URL'],
    [{ N2F_MAIL_TRANSPORT: 'sendmail' }, 'N2F_MAIL_TRANSPORT'],
    [{ N2F_MAIL_FROM: 'a@example.com\r\nBcc: x@example.com' }, 'N2F_MAIL_FROM'],
    [{ N2F_APP_URL: 'https://user:pw@app.example.com' }, 'N2F_APP_URL'],
    [{ N2F_APP_URL: 'https://app.example.com/?next=1' }, 'N2F_APP_URL'],
    [{ N2F_APP_URL: 'javascript:alert(1)' }, 'N2F_APP_URL'],
  ])('refuses invalid mail setting %j', (values, variable) => {
    const result = parseRuntimeConfig(map(values));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.error.fields ?? {})).toContain(variable);
  });

  it('enables development endpoints only when explicitly requested', () => {
    const enabled = parseRuntimeConfig(map({ N2F_DEV_ENDPOINTS: 'true' }));
    const invalid = parseRuntimeConfig(map({ N2F_DEV_ENDPOINTS: 'yes' }));

    expect(enabled.ok && enabled.value.http.devEndpoints).toBe(true);
    expect(invalid.ok).toBe(false);
  });

  it.each([
    ['false', false],
    ['1', 1],
    ['loopback', ['loopback']],
    ['10.0.0.0/8, 192.168.1.4', ['10.0.0.0/8', '192.168.1.4']],
    ['fd00::/8', ['fd00::/8']],
  ])('accepts trust proxy setting %s', (value, expected) => {
    const result = parseRuntimeConfig(map({ N2F_TRUST_PROXY: value }));

    expect(result.ok && result.value.http.trustProxy).toEqual(expected);
  });

  it.each(['true', '0', '10', 'everyone', '10.0.0.0/8,', ''])(
    'refuses trust proxy setting %j',
    (value) => {
      const result = parseRuntimeConfig(map({ N2F_TRUST_PROXY: value }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('env.invalid');
      }
    },
  );

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

  describe('production', () => {
    const durable = {
      N2F_ENV: 'production',
      N2F_METRICS_TOKEN: 'm'.repeat(32),
      N2F_STORAGE: 'postgres',
      N2F_DATABASE_URL: 'postgres://localhost/n2f',
      N2F_EVENT_TRANSPORT: 'local',
      N2F_MAIL_TRANSPORT: 'smtp',
      N2F_SMTP_URL: 'smtps://mail.example.com:465',
      N2F_APP_URL: 'https://app.example.com',
    };

    it('accepts a durable configuration', () => {
      expect(parseRuntimeConfig(map(durable)).ok).toBe(true);
    });

    it('holds sign-up responses to a one-second floor by default', () => {
      const result = parseRuntimeConfig(map(durable));
      expect(result.ok && result.value.http.signupFloorMs).toBe(1000);
    });

    it('refuses memory storage and development endpoints, naming each variable', () => {
      const result = parseRuntimeConfig(
        map({ N2F_ENV: 'production', N2F_DEV_ENDPOINTS: 'true' }),
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          type: 'env.unsafe_for_production',
          fields: {
            N2F_STORAGE: 'production_requires_postgres',
            N2F_DEV_ENDPOINTS: 'forbidden_in_production',
            N2F_METRICS_TOKEN: 'required_in_production',
            N2F_MAIL_TRANSPORT: 'production_requires_smtp',
            N2F_APP_URL: 'required_in_production',
          },
        },
      });
      if (!result.ok) {
        expect(describeConfigFailure(result.error)).toBe(
          'unsafe configuration for production: N2F_STORAGE (production_requires_postgres), N2F_DEV_ENDPOINTS (forbidden_in_production), N2F_METRICS_TOKEN (required_in_production), N2F_MAIL_TRANSPORT (production_requires_smtp), N2F_APP_URL (required_in_production)',
        );
      }
    });

    it('refuses the capture mailer, which would expose verification tokens', () => {
      const result = parseRuntimeConfig(
        map({ ...durable, N2F_MAIL_TRANSPORT: 'capture', N2F_SMTP_URL: '' }),
      );

      expect(result).toMatchObject({
        ok: false,
        error: { fields: { N2F_MAIL_TRANSPORT: 'production_requires_smtp' } },
      });
    });

    it('names an invalid variable in the startup message', () => {
      const result = parseRuntimeConfig(map({ N2F_TRUST_PROXY: 'everyone' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(describeConfigFailure(result.error)).toContain('N2F_TRUST_PROXY');
      }
    });
  });
});
