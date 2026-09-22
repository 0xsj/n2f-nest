import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

const enabled = process.env.N2F_RUN_IDENTITY_INTEGRATION === '1';
const integration = enabled ? describe : describe.skip;

integration('Identity HTTP integration', () => {
  let app: INestApplication | undefined;

  beforeAll(async () => {
    process.env.N2F_STORAGE = 'memory';
    process.env.N2F_EVENT_TRANSPORT = 'local';
    app = await NestFactory.create(AppModule, { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('enforces authentication boundaries and projects the complete lifecycle', async () => {
    if (!app) throw new Error('Nest application was not initialized');
    const server = app.getHttpServer();
    const email = `identity-${randomUUID()}@example.com`;
    const password = 'correct horse battery staple';

    const missingToken = await request(server).get('/identity/me');
    expect(missingToken.status).toBe(401);
    expect(missingToken.body.code).toBe('identity.missing_token');

    const limitedEmail = `limited-${randomUUID()}@example.com`;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request(server)
        .post('/identity/login')
        .send({ email: limitedEmail, password: 'wrong password' });
      expect(response.status).toBe(401);
    }
    const limited = await request(server)
      .post('/identity/login')
      .send({ email: limitedEmail, password: 'wrong password' });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('rate_limit.exceeded');
    expect(limited.headers['retry-after']).toBeDefined();

    const emptyPassword = await request(server)
      .post('/identity/register')
      .send({ email, password: '' });
    expect(emptyPassword.status).toBe(400);
    expect(emptyPassword.body.code).toBe('identity.empty_password');

    const registered = await request(server)
      .post('/identity/register')
      .send({ email, password });
    expect(registered.status).toBe(201);

    const wrongPassword = await request(server)
      .post('/identity/login')
      .send({ email, password: 'wrong password' });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.code).toBe('identity.invalid_credentials');

    const challenge = await request(server)
      .post('/identity/verification-challenges')
      .send({ identityId: registered.body.identityId });
    expect(challenge.status).toBe(201);

    const verified = await request(server)
      .post('/identity/verify')
      .send({
        challengeId: challenge.body.challengeId,
        token: challenge.body.token,
      });
    expect(verified.status).toBe(201);

    const loggedIn = await request(server)
      .post('/identity/login')
      .send({ email, password });
    expect(loggedIn.status).toBe(201);

    const token = loggedIn.body.token as string;
    const current = await request(server)
      .get('/identity/me')
      .set('Authorization', `Bearer ${token}`);
    expect(current.status).toBe(200);
    expect(current.body.identityId).toBe(registered.body.identityId);

    const loggedOut = await request(server)
      .post('/identity/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(loggedOut.status).toBe(201);

    const revoked = await request(server)
      .get('/identity/me')
      .set('Authorization', `Bearer ${token}`);
    expect(revoked.status).toBe(401);

    const audit = await request(server).get('/audit/entries');
    expect(audit.status).toBe(200);
    expect(
      audit.body
        .filter(
          (entry: { subject?: { id?: string } }) =>
            entry.subject?.id === registered.body.identityId,
        )
        .map((entry: { eventType: string }) => entry.eventType)
        .sort(),
    ).toEqual([
      'identity.registered.v1',
      'identity.session.created.v1',
      'identity.session.revoked.v1',
      'identity.verification.challenge.issued.v1',
      'identity.verified.v1',
    ]);
  });
});
