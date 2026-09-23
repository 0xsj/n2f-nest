import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpApplication } from '../src/app/http-application.js';
import { map } from '../src/shared/env/index.js';
import { parseRuntimeConfig } from '../src/platform/runtime/index.js';
import { tenants } from './support/tenants.js';

/**
 * A login beyond `N2F_SESSION_MAX_PER_IDENTITY` signs out the identity's
 * oldest session. Idle expiry and pruning are pinned by the Session domain,
 * GetCurrentIdentity and adapter contract specs, which control time. Memory
 * mode needs no infrastructure, so this suite always runs.
 */
describe('Session limits over HTTP', () => {
  let app: INestApplication | undefined;
  const { server, identity } = tenants(() => app!);

  beforeAll(async () => {
    const parsed = parseRuntimeConfig(map({ N2F_STORAGE: 'memory', N2F_EVENT_TRANSPORT: 'local' }));
    if (!parsed.ok) throw new Error(parsed.error.message);
    // Identity reads its session limits from the environment at startup.
    process.env.N2F_SESSION_MAX_PER_IDENTITY = '2';
    try {
      app = await createHttpApplication(parsed.value, { logger: false });
    } finally {
      delete process.env.N2F_SESSION_MAX_PER_IDENTITY;
    }
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
  });

  it("revokes the oldest session when a login exceeds the identity's cap", async () => {
    const first = await identity();
    const login = async () => {
      const response = await request(server())
        .post('/identity/login')
        .send({ email: first.email, password: first.password });
      expect(response.status).toBe(201);
      return response.body.token as string;
    };
    const me = (token: string) =>
      request(server()).get('/identity/me').set('Authorization', `Bearer ${token}`);

    const second = await login();
    expect((await me(first.token)).status).toBe(200);

    const third = await login();

    expect((await me(first.token)).status).toBe(401);
    expect((await me(second)).status).toBe(200);
    expect((await me(third)).status).toBe(200);
  });
});
