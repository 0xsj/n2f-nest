import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

const enabled = process.env.N2F_RUN_DOCUMENT_PROCESSING_INTEGRATION === '1';
const integration = enabled ? describe : describe.skip;

integration('Document processing workflow integration', () => {
  let app: INestApplication | undefined;

  beforeAll(async () => {
    process.env.N2F_IDENTITY_STORAGE = 'memory';
    process.env.N2F_EVENT_TRANSPORT = 'local';
    app = await NestFactory.create(AppModule, { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('coordinates document and job lifecycles without coupling their modules', async () => {
    if (!app) throw new Error('Nest application was not initialized');
    const server = app.getHttpServer();
    const email = `processing-${randomUUID()}@example.com`;
    const password = 'correct horse battery staple';

    const registered = await request(server)
      .post('/identity/register')
      .send({ email, password });
    const challenge = await request(server)
      .post('/identity/verification-challenges')
      .send({ identityId: registered.body.identityId });
    await request(server)
      .post('/identity/verify')
      .send({
        challengeId: challenge.body.challengeId,
        token: challenge.body.token,
      });
    const loggedIn = await request(server)
      .post('/identity/login')
      .send({ email, password });
    expect(loggedIn.status).toBe(201);
    const token = loggedIn.body.token as string;

    const organization = await request(server)
      .post('/organizations')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Workflow Agency', slug: `workflow-${randomUUID().slice(0, 8)}` });
    expect(organization.status).toBe(201);
    const organizationId = organization.body.organizationId as string;

    const document = await request(server)
      .post(`/organizations/${organizationId}/documents`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Process me.pdf' });
    expect(document.status).toBe(201);
    const documentId = document.body.documentId as string;

    const requested = await request(server)
      .post(`/organizations/${organizationId}/documents/${documentId}/process`)
      .set('Authorization', `Bearer ${token}`)
      .send({ maxAttempts: 2 });
    expect(requested.status).toBe(201);
    expect(requested.body).toEqual({
      documentId,
      jobId: expect.any(String),
      documentStatus: 'processing',
      jobStatus: 'queued',
      jobCreated: true,
    });

    const repeated = await request(server)
      .post(`/organizations/${organizationId}/documents/${documentId}/process`)
      .set('Authorization', `Bearer ${token}`)
      .send({ maxAttempts: 2 });
    expect(repeated.status).toBe(201);
    expect(repeated.body).toEqual({
      documentId,
      jobId: requested.body.jobId,
      documentStatus: 'processing',
      jobStatus: 'queued',
      jobCreated: false,
    });

    const started = await request(server)
      .post(`/organizations/${organizationId}/jobs/${requested.body.jobId}/start`)
      .set('Authorization', `Bearer ${token}`);
    expect(started.status).toBe(200);

    const completed = await request(server)
      .post(`/organizations/${organizationId}/jobs/${requested.body.jobId}/complete`)
      .set('Authorization', `Bearer ${token}`);
    expect(completed.status).toBe(200);

    const processed = await request(server)
      .get(`/organizations/${organizationId}/documents/${documentId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(processed.status).toBe(200);
    expect(processed.body.status).toBe('processed');

    const failedDocument = await request(server)
      .post(`/organizations/${organizationId}/documents`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Retry me.pdf' });
    const failedDocumentId = failedDocument.body.documentId as string;
    const failedRequest = await request(server)
      .post(`/organizations/${organizationId}/documents/${failedDocumentId}/process`)
      .set('Authorization', `Bearer ${token}`)
      .send({ maxAttempts: 2 });
    const failedJobId = failedRequest.body.jobId as string;
    await request(server)
      .post(`/organizations/${organizationId}/jobs/${failedJobId}/start`)
      .set('Authorization', `Bearer ${token}`);
    const failed = await request(server)
      .post(`/organizations/${organizationId}/jobs/${failedJobId}/fail`)
      .set('Authorization', `Bearer ${token}`)
      .send({ failureCode: 'provider.timeout' });
    expect(failed.status).toBe(200);

    const processingFailed = await request(server)
      .get(`/organizations/${organizationId}/documents/${failedDocumentId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(processingFailed.body).toMatchObject({
      status: 'processing_failed',
      processingFailureCode: 'provider.timeout',
    });

    const retried = await request(server)
      .post(`/organizations/${organizationId}/jobs/${failedJobId}/retry`)
      .set('Authorization', `Bearer ${token}`);
    expect(retried.status).toBe(200);
    const processingAgain = await request(server)
      .get(`/organizations/${organizationId}/documents/${failedDocumentId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(processingAgain.body.status).toBe('processing');
  });
});
