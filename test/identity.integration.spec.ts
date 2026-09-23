import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { eventually } from './support/eventually.js';
import { mailbox, verificationFrom } from './support/mail.js';

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
    expect(registered.status).toBe(202);

    const wrongPassword = await request(server)
      .post('/identity/login')
      .send({ email, password: 'wrong password' });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.code).toBe('identity.invalid_credentials');

    // Unverified: the password is right but login still refuses.
    const unverified = await request(server)
      .post('/identity/login')
      .send({ email, password });
    expect(unverified.status).toBe(401);

    const mail = await request(server).get(mailbox(email));
    expect(mail.body).toHaveLength(1);
    const verified = await request(server)
      .post('/identity/verify')
      .send(verificationFrom(mail.body[0]));
    expect(verified.status).toBe(201);

    const loggedIn = await request(server)
      .post('/identity/login')
      .send({ email, password });
    expect(loggedIn.status).toBe(201);
    const identityId = loggedIn.body.identityId as string;

    const token = loggedIn.body.token as string;
    const current = await request(server)
      .get('/identity/me')
      .set('Authorization', `Bearer ${token}`);
    expect(current.status).toBe(200);
    expect(current.body.identityId).toBe(identityId);

    const loggedOut = await request(server)
      .post('/identity/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(loggedOut.status).toBe(201);

    const revoked = await request(server)
      .get('/identity/me')
      .set('Authorization', `Bearer ${token}`);
    expect(revoked.status).toBe(401);

    const identityEntries = (body: Array<{ subject?: { id?: string } }>) =>
      body.filter((entry) => entry.subject?.id === identityId);
    const audit = await eventually(
      () => request(server).get('/audit/entries'),
      (response) => identityEntries(response.body).length >= 5,
    );
    expect(audit.status).toBe(200);
    expect(
      audit.body
        .filter(
          (entry: { subject?: { id?: string } }) =>
            entry.subject?.id === identityId,
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

  it('answers sign-up and resend alike whether or not an account exists', async () => {
    if (!app) throw new Error('Nest application was not initialized');
    const server = app.getHttpServer();
    const password = 'correct horse battery staple';
    const taken = `taken-${randomUUID()}@example.com`;
    const unknown = `unknown-${randomUUID()}@example.com`;
    const strip = (response: request.Response) => ({ status: response.status, body: response.body });

    const first = await request(server).post('/identity/register').send({ email: taken, password });
    const again = await request(server)
      .post('/identity/register')
      .send({ email: ` ${taken.toUpperCase()} `, password: 'another long password' });

    expect(strip(again)).toEqual(strip(first));
    expect(first.body).not.toHaveProperty('identityId');
    const takenMail = (await request(server).get(mailbox(taken))).body as Array<{ subject: string }>;
    expect(takenMail.map((message) => message.subject)).toEqual([
      'Sign-up attempt for your account',
      'Confirm your email address',
    ]);

    // Resend: a pending account gets a fresh link; an unknown email gets
    // nothing; both answer alike.
    const resent = await request(server).post('/identity/verification-challenges').send({ email: taken });
    const nobody = await request(server).post('/identity/verification-challenges').send({ email: unknown });
    expect(strip(nobody)).toEqual(strip(resent));
    expect((await request(server).get(mailbox(unknown))).body).toEqual([]);

    const latest = (await request(server).get(mailbox(taken))).body;
    expect(latest).toHaveLength(3);
    const verified = await request(server).post('/identity/verify').send(verificationFrom(latest[0]));
    expect(verified.status).toBe(201);
    // The first password still signs in; the second attempt changed nothing.
    expect((await request(server).post('/identity/login').send({ email: taken, password })).status).toBe(201);

    // Verified accounts get no more links.
    await request(server).post('/identity/verification-challenges').send({ email: taken });
    expect((await request(server).get(mailbox(taken))).body).toHaveLength(3);
  });
});
