import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { EVENT_INBOX } from '../src/platform/events/event-delivery.js';
import type { InMemoryInbox } from '../src/shared/events/index.js';
import { eventually } from './support/eventually.js';
import { mailbox, verificationFrom } from './support/mail.js';
import { tenants } from './support/tenants.js';

const enabled = process.env.N2F_RUN_DOCUMENT_PROCESSING_INTEGRATION === '1';
const integration = enabled ? describe : describe.skip;

integration('Document processing workflow integration', () => {
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

  it('coordinates document and job lifecycles without coupling their modules', async () => {
    if (!app) throw new Error('Nest application was not initialized');
    const server = app.getHttpServer();
    const email = `processing-${randomUUID()}@example.com`;
    const password = 'correct horse battery staple';

    const registered = await request(server)
      .post('/identity/register')
      .send({ email, password });
    const mail = await request(server).get(mailbox(email));
    await request(server).post('/identity/verify').send(verificationFrom(mail.body[0]));
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

    const processed = await eventually(
      () =>
        request(server)
          .get(`/organizations/${organizationId}/documents/${documentId}`)
          .set('Authorization', `Bearer ${token}`),
      (response) => response.body.status === 'processed',
    );
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

    const processingFailed = await eventually(
      () =>
        request(server)
          .get(`/organizations/${organizationId}/documents/${failedDocumentId}`)
          .set('Authorization', `Bearer ${token}`),
      (response) => response.body.status === 'processing_failed',
    );
    expect(processingFailed.body).toMatchObject({
      status: 'processing_failed',
      processingFailureCode: 'provider.timeout',
    });

    const retried = await request(server)
      .post(`/organizations/${organizationId}/jobs/${failedJobId}/retry`)
      .set('Authorization', `Bearer ${token}`);
    expect(retried.status).toBe(200);
    const processingAgain = await eventually(
      () =>
        request(server)
          .get(`/organizations/${organizationId}/documents/${failedDocumentId}`)
          .set('Authorization', `Bearer ${token}`),
      (response) => response.body.status === 'processing',
    );
    expect(processingAgain.body.status).toBe('processing');
  });

  it('manages documents and jobs directly over HTTP', async () => {
    if (!app) throw new Error('Nest application was not initialized');
    const server = app.getHttpServer();
    const owner = await tenants(() => app!).tenant();
    const created = { body: { organizationId: owner.organizationId } };
    const loggedIn = { body: { token: owner.token } };

    const document = await request(server)
      .post(`/organizations/${created.body.organizationId}/documents`)
      .set('Authorization', `Bearer ${loggedIn.body.token}`)
      .send({
        name: 'Contract.pdf',
        storageKey: 'documents/contract.pdf',
      });

    expect(document.status).toBe(201);
    expect(document.body).toEqual({
      documentId: expect.any(String),
      organizationId: created.body.organizationId,
      name: 'Contract.pdf',
      storageKey: 'documents/contract.pdf',
      status: 'active',
    });

    const listedDocuments = await request(server)
      .get(`/organizations/${created.body.organizationId}/documents`)
      .set('Authorization', `Bearer ${loggedIn.body.token}`);

    expect(listedDocuments.status).toBe(200);
    expect(listedDocuments.body).toEqual([
      {
        documentId: document.body.documentId,
        organizationId: created.body.organizationId,
        name: 'Contract.pdf',
        storageKey: 'documents/contract.pdf',
        status: 'active',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        archivedAt: null,
      },
    ]);

    const archivedDocument = await request(server)
      .post(
        `/organizations/${created.body.organizationId}/documents/${document.body.documentId}/archive`,
      )
      .set('Authorization', `Bearer ${loggedIn.body.token}`);

    expect(archivedDocument.status).toBe(200);
    expect(archivedDocument.body).toEqual({
      documentId: document.body.documentId,
      status: 'archived',
      archivedAt: expect.any(String),
    });

    const fetchedDocument = await request(server)
      .get(
        `/organizations/${created.body.organizationId}/documents/${document.body.documentId}`,
      )
      .set('Authorization', `Bearer ${loggedIn.body.token}`);

    expect(fetchedDocument.status).toBe(200);
    expect(fetchedDocument.body).toMatchObject({
      documentId: document.body.documentId,
      status: 'archived',
      archivedAt: expect.any(String),
    });

    const submittedJob = await request(server)
      .post(`/organizations/${created.body.organizationId}/jobs`)
      .set('Authorization', `Bearer ${loggedIn.body.token}`)
      .send({ kind: 'document.process', maxAttempts: 2 });

    expect(submittedJob.status).toBe(201);
    expect(submittedJob.body).toEqual({
      jobId: expect.any(String),
      organizationId: created.body.organizationId,
      kind: 'document.process',
      status: 'queued',
      attempts: 0,
      maxAttempts: 2,
    });

    const startedJob = await request(server)
      .post(
        `/organizations/${created.body.organizationId}/jobs/${submittedJob.body.jobId}/start`,
      )
      .set('Authorization', `Bearer ${loggedIn.body.token}`);
    expect(startedJob.status).toBe(200);
    expect(startedJob.body).toMatchObject({
      jobId: submittedJob.body.jobId,
      status: 'running',
      attempts: 1,
      finishedAt: null,
    });

    const failedJob = await request(server)
      .post(
        `/organizations/${created.body.organizationId}/jobs/${submittedJob.body.jobId}/fail`,
      )
      .set('Authorization', `Bearer ${loggedIn.body.token}`)
      .send({ failureCode: 'provider.timeout' });
    expect(failedJob.status).toBe(200);
    expect(failedJob.body).toMatchObject({
      jobId: submittedJob.body.jobId,
      status: 'failed',
      attempts: 1,
      finishedAt: expect.any(String),
    });

    const retriedJob = await request(server)
      .post(
        `/organizations/${created.body.organizationId}/jobs/${submittedJob.body.jobId}/retry`,
      )
      .set('Authorization', `Bearer ${loggedIn.body.token}`);
    expect(retriedJob.status).toBe(200);
    expect(retriedJob.body).toMatchObject({
      jobId: submittedJob.body.jobId,
      status: 'queued',
      attempts: 1,
      finishedAt: null,
    });

    const restartedJob = await request(server)
      .post(
        `/organizations/${created.body.organizationId}/jobs/${submittedJob.body.jobId}/start`,
      )
      .set('Authorization', `Bearer ${loggedIn.body.token}`);
    expect(restartedJob.status).toBe(200);
    expect(restartedJob.body.attempts).toBe(2);

    const completedJob = await request(server)
      .post(
        `/organizations/${created.body.organizationId}/jobs/${submittedJob.body.jobId}/complete`,
      )
      .set('Authorization', `Bearer ${loggedIn.body.token}`);
    expect(completedJob.status).toBe(200);
    expect(completedJob.body).toMatchObject({
      jobId: submittedJob.body.jobId,
      status: 'succeeded',
      attempts: 2,
      finishedAt: expect.any(String),
    });

    const cancelableJob = await request(server)
      .post(`/organizations/${created.body.organizationId}/jobs`)
      .set('Authorization', `Bearer ${loggedIn.body.token}`)
      .send({ kind: 'document.cleanup' });
    expect(cancelableJob.status).toBe(201);

    const canceledJob = await request(server)
      .post(
        `/organizations/${created.body.organizationId}/jobs/${cancelableJob.body.jobId}/cancel`,
      )
      .set('Authorization', `Bearer ${loggedIn.body.token}`);
    expect(canceledJob.status).toBe(200);
    expect(canceledJob.body).toMatchObject({
      jobId: cancelableJob.body.jobId,
      status: 'canceled',
      finishedAt: expect.any(String),
    });

    const jobs = await request(server)
      .get(`/organizations/${created.body.organizationId}/jobs`)
      .set('Authorization', `Bearer ${loggedIn.body.token}`);
    expect(jobs.status).toBe(200);
    expect(jobs.body).toHaveLength(2);
  });

  describe('job outcomes that the review found stranded documents', () => {
    // One organization for every case (each uses its own document): the
    // registration rate limit allows five per client per window.
    let shared: ReturnType<typeof open> | undefined;
    const workspace = () => (shared ??= open());

    async function open() {
      if (!app) throw new Error('Nest application was not initialized');
      const server = app.getHttpServer();
      const email = `outcomes-${randomUUID()}@example.com`;
      const password = 'correct horse battery staple';
      const registered = await request(server).post('/identity/register').send({ email, password });
      const mail = await request(server).get(mailbox(email));
      await request(server).post('/identity/verify').send(verificationFrom(mail.body[0]));
      const token = (await request(server).post('/identity/login').send({ email, password })).body
        .token as string;
      const organizationId = (
        await request(server)
          .post('/organizations')
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Outcomes Agency', slug: `outcomes-${randomUUID().slice(0, 8)}` })
      ).body.organizationId as string;
      const base = `/organizations/${organizationId}`;
      const post = (path: string, body: object = {}) =>
        request(server).post(base + path).set('Authorization', `Bearer ${token}`).send(body);
      const get = (path: string) =>
        request(server).get(base + path).set('Authorization', `Bearer ${token}`);
      const document = async () =>
        (await post('/documents', { name: `${randomUUID()}.pdf` })).body.documentId as string;
      const settle = (documentId: string, done: (body: Record<string, unknown>) => boolean) =>
        eventually(
          async () => (await get(`/documents/${documentId}`)).body,
          (body) => done(body) && inbox().unsettled('document-processing') === 0,
        );
      return { post, get, document, settle };
    }
    const inbox = () => app!.get(EVENT_INBOX) as InMemoryInbox;

    it('processes a document again after its job was canceled', async () => {
      const { post, document, settle } = await workspace();
      const documentId = await document();
      const first = (await post(`/documents/${documentId}/process`)).body.jobId as string;
      await post(`/jobs/${first}/start`);
      await post(`/jobs/${first}/cancel`);
      expect((await settle(documentId, (body) => body.status === 'processing_failed')).processingFailureCode).toBe(
        'job.canceled',
      );

      const again = await post(`/documents/${documentId}/process`);

      expect(again.status).toBe(201);
      expect(again.body).toMatchObject({ jobCreated: true, documentStatus: 'processing' });
      expect(again.body.jobId).not.toBe(first);
      await post(`/jobs/${again.body.jobId}/start`);
      await post(`/jobs/${again.body.jobId}/complete`);
      expect((await settle(documentId, (body) => body.status === 'processed')).status).toBe('processed');
    });

    it('retries a failed job with attempts left instead of creating another', async () => {
      const { post, document, settle } = await workspace();
      const documentId = await document();
      const job = (await post(`/documents/${documentId}/process`, { maxAttempts: 2 })).body.jobId;
      await post(`/jobs/${job}/start`);
      await post(`/jobs/${job}/fail`, { failureCode: 'provider.timeout' });
      await settle(documentId, (body) => body.status === 'processing_failed');

      const again = await post(`/documents/${documentId}/process`);

      expect(again.body).toMatchObject({ jobId: job, jobCreated: false, jobStatus: 'queued' });
      expect((await settle(documentId, (body) => body.status === 'processing')).status).toBe('processing');
    });

    it('keeps the original failure when a failed job is canceled afterwards', async () => {
      const { post, document, settle } = await workspace();
      const documentId = await document();
      const job = (await post(`/documents/${documentId}/process`, { maxAttempts: 1 })).body.jobId;
      await post(`/jobs/${job}/start`);
      await post(`/jobs/${job}/fail`, { failureCode: 'provider.timeout' });
      await settle(documentId, (body) => body.status === 'processing_failed');

      expect((await post(`/jobs/${job}/cancel`)).status).toBe(200);

      const settled = await settle(documentId, () => true);
      expect(settled).toMatchObject({ status: 'processing_failed', processingFailureCode: 'provider.timeout' });
    });

    it('ignores job outcomes once the document is archived mid-processing', async () => {
      const { post, document, settle } = await workspace();
      const documentId = await document();
      const job = (await post(`/documents/${documentId}/process`)).body.jobId;
      await post(`/jobs/${job}/start`);
      expect((await post(`/documents/${documentId}/archive`)).status).toBe(200);

      expect((await post(`/jobs/${job}/complete`)).status).toBe(200);

      expect((await settle(documentId, () => true)).status).toBe('archived');
    });
  });
});
