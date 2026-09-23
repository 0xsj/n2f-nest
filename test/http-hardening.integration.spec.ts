import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpApplication } from '../src/app/http-application.js';
import { map } from '../src/shared/env/index.js';
import { parseRuntimeConfig, type RuntimeConfig } from '../src/platform/runtime/index.js';
import { eventually } from './support/eventually.js';

/**
 * The HTTP application as main.ts builds it (hardening items S8, S9, S10).
 * Memory mode needs no infrastructure, so this suite always runs.
 */
function config(values: Record<string, string> = {}): RuntimeConfig {
  const parsed = parseRuntimeConfig(
    map({ N2F_STORAGE: 'memory', N2F_EVENT_TRANSPORT: 'local', N2F_DEV_ENDPOINTS: 'true', ...values }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

describe('HTTP hardening', () => {
  let app: INestApplication | undefined;
  let withCors: INestApplication | undefined;

  beforeAll(async () => {
    app = await createHttpApplication(config(), { logger: false });
    await app.init();
    withCors = await createHttpApplication(
      config({ N2F_CORS_ORIGINS: 'https://app.example.com' }),
      { logger: false },
    );
    await withCors.init();
  });

  afterAll(async () => {
    await app?.close();
    await withCors?.close();
  });

  const server = () => app!.getHttpServer();

  it('sends security headers and no framework fingerprint', async () => {
    const response = await request(server()).get('/health/live');

    expect(response.headers).toMatchObject({
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    });
    expect(response.headers['strict-transport-security']).toContain('max-age=');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('refuses a request body over the limit', async () => {
    const response = await request(server())
      .post('/identity/register')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'big@example.com', password: 'x'.repeat(70 * 1024) }));

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ code: 'http.body_too_large', status: 413 });
    expect(response.body.request_id).toBe(response.headers['x-request-id']);
  });

  it('answers malformed JSON with a problem that echoes no request text', async () => {
    const response = await request(server())
      .post('/identity/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "secret-typo@example.com", "password": ');

    expect(response.status).toBe(400);
    // The framework reports the parse error; only a sanitized problem leaves.
    expect(response.body).toMatchObject({ status: 400, kind: 'invalid' });
    expect(['http.invalid_json', 'http.bad_request']).toContain(response.body.code);
    expect(JSON.stringify(response.body)).not.toContain('secret-typo');
  });

  it('does not parse bodies that are not JSON', async () => {
    const response = await request(server())
      .post('/identity/register')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('email=form@example.com&password=correct+horse+battery+staple');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('http.invalid_body');
  });

  it('never lets a client choose the request ID recorded in provenance', async () => {
    const chosen = randomUUID();
    const registered = await request(server())
      .post('/identity/register')
      .set('x-request-id', chosen)
      .send({ email: `provenance-${randomUUID()}@example.com`, password: 'correct horse battery staple' });

    expect(registered.status).toBe(202);
    expect(registered.headers['x-client-request-id']).toBe(chosen);
    expect(registered.headers['x-request-id']).not.toBe(chosen);
    const serverId = registered.headers['x-request-id'];
    const recordedUnder = (response: { body: Array<{ eventType: string; workId?: string }> }, workId: string) =>
      response.body.some((entry) => entry.eventType === 'identity.registered.v1' && entry.workId === workId);
    const audit = await eventually(
      () => request(server()).get('/audit/entries?limit=100'),
      (response) => recordedUnder(response, serverId),
    );
    expect(recordedUnder(audit, serverId)).toBe(true);
    expect(recordedUnder(audit, chosen)).toBe(false);
  });

  it('allows no cross-origin browser calls unless an origin is configured', async () => {
    const denied = await request(server())
      .options('/identity/login')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();

    const allowed = await request(withCors!.getHttpServer())
      .options('/identity/login')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com');

    const other = await request(withCors!.getHttpServer())
      .options('/identity/login')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves metrics only with the configured bearer token', async () => {
    const token = 'metrics-'.padEnd(40, 'x');
    process.env.N2F_METRICS_TOKEN = token;
    const guarded = await createHttpApplication(config({ N2F_METRICS_TOKEN: token }), { logger: false });
    await guarded.init();
    delete process.env.N2F_METRICS_TOKEN;
    try {
      const anonymous = await request(guarded.getHttpServer()).get('/metrics');
      const wrong = await request(guarded.getHttpServer())
        .get('/metrics')
        .set('Authorization', 'Bearer not-the-token');
      const scraped = await request(guarded.getHttpServer())
        .get('/metrics')
        .set('Authorization', `Bearer ${token}`);

      expect(anonymous.status).toBe(401);
      expect(anonymous.body.code).toBe('metrics.unauthenticated');
      expect(wrong.status).toBe(401);
      expect(scraped.status).toBe(200);
      expect(scraped.text).toContain('n2f_http_requests_total');
    } finally {
      await guarded.close();
    }
  });
});
