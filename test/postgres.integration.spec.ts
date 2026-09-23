import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { failure, ok } from '../src/shared/errors/index.js';
import { DATABASE } from '../src/platform/runtime/index.js';
import {
  ChaosTransactionDatabase,
  FaultInjector,
} from '../src/platform/chaos/index.js';
import type { Database } from '../src/shared/postgres/index.js';
import { mailbox, verificationFrom } from './support/mail.js';
import { resetLoopbackRateLimits } from './support/rate-limits.js';

const enabled = process.env.N2F_RUN_POSTGRES_INTEGRATION === '1';
const integration = enabled ? describe : describe.skip;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function eventually<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();

  while (!ready(value) && Date.now() < deadline) {
    await delay(50);
    value = await read();
  }

  if (!ready(value)) {
    throw new Error(`condition was not met within ${timeoutMs}ms`);
  }

  return value;
}

integration('PostgreSQL runtime integration', () => {
  let app: INestApplication | undefined;

  beforeAll(async () => {
    await resetLoopbackRateLimits();
    app = await NestFactory.create(AppModule, { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('runs the complete auth lifecycle through the durable event path', async () => {
    if (!app) throw new Error('Nest application was not initialized');

    const email = `postgres-${randomUUID()}@example.com`;
    const password = 'correct horse battery staple';
    const registered = await request(app.getHttpServer())
      .post('/identity/register')
      .send({ email, password });

    expect(registered.status).toBe(202);
    expect(registered.body).toMatchObject({ status: 'accepted' });

    const mail = await request(app.getHttpServer()).get(mailbox(email));
    expect(mail.body).toHaveLength(1);

    const verified = await request(app.getHttpServer())
      .post('/identity/verify')
      .send(verificationFrom(mail.body[0]));

    expect(verified.status).toBe(201);
    expect(verified.body).toEqual({
      identityId: expect.any(String),
      status: 'active',
    });
    const identityId = verified.body.identityId as string;

    const loggedIn = await request(app.getHttpServer())
      .post('/identity/login')
      .send({ email, password });

    expect(loggedIn.status).toBe(201);
    expect(loggedIn.body.identityId).toBe(identityId);
    expect(typeof loggedIn.body.sessionId).toBe('string');
    expect(typeof loggedIn.body.token).toBe('string');

    const sessionToken = loggedIn.body.token as string;
    const current = await request(app.getHttpServer())
      .get('/identity/me')
      .set('Authorization', `Bearer ${sessionToken}`);

    expect(current.status).toBe(200);
    expect(current.body).toEqual({
      identityId,
      status: 'active',
      verifiedAt: expect.any(String),
    });

    const organization = await request(app.getHttpServer())
      .post('/organizations')
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({
        name: 'Example Organization',
        slug: `n2f-${randomUUID().slice(0, 8)}`,
      });

    expect(organization.status).toBe(201);
    expect(organization.body).toEqual({
      organizationId: expect.any(String),
      ownerMembershipId: expect.any(String),
    });

    const ownerRoleChange = await request(app.getHttpServer())
      .patch(
        `/organizations/${organization.body.organizationId}/memberships/${organization.body.ownerMembershipId}/role`,
      )
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({ role: 'admin' });

    expect(ownerRoleChange.status).toBe(403);

    const organizations = await request(app.getHttpServer())
      .get('/organizations')
      .set('Authorization', `Bearer ${sessionToken}`);

    expect(organizations.status).toBe(200);
    expect(organizations.body).toEqual([
      {
        organizationId: organization.body.organizationId,
        name: 'Example Organization',
        slug: expect.stringMatching(/^n2f-[a-f0-9]{8}$/),
        status: 'active',
        membershipId: organization.body.ownerMembershipId,
        role: 'owner',
        membershipStatus: 'active',
      },
    ]);

    const document = await request(app.getHttpServer())
      .post(`/organizations/${organization.body.organizationId}/documents`)
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({
        name: 'Durable contract.pdf',
        storageKey: 'documents/durable-contract.pdf',
      });

    expect(document.status).toBe(201);
    expect(document.body).toEqual({
      documentId: expect.any(String),
      organizationId: organization.body.organizationId,
      name: 'Durable contract.pdf',
      storageKey: 'documents/durable-contract.pdf',
      status: 'active',
    });

    const processing = await request(app.getHttpServer())
      .post(
        `/organizations/${organization.body.organizationId}/documents/${document.body.documentId}/process`,
      )
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({ maxAttempts: 2 });

    expect(processing.status).toBe(201);
    expect(processing.body).toEqual({
      documentId: document.body.documentId,
      jobId: expect.any(String),
      documentStatus: 'processing',
      jobStatus: 'queued',
      jobCreated: true,
    });

    const processingJobStarted = await request(app.getHttpServer())
      .post(
        `/organizations/${organization.body.organizationId}/jobs/${processing.body.jobId}/start`,
      )
      .set('Authorization', `Bearer ${sessionToken}`);
    expect(processingJobStarted.status).toBe(200);

    const processingJobCompleted = await request(app.getHttpServer())
      .post(
        `/organizations/${organization.body.organizationId}/jobs/${processing.body.jobId}/complete`,
      )
      .set('Authorization', `Bearer ${sessionToken}`);
    expect(processingJobCompleted.status).toBe(200);

    const processed = await eventually(
      async () => {
        return request(app!.getHttpServer())
          .get(
            `/organizations/${organization.body.organizationId}/documents/${document.body.documentId}`,
          )
          .set('Authorization', `Bearer ${sessionToken}`);
      },
      (response) =>
        response.status === 200 && response.body.status === 'processed',
    );
    expect(processed.body.status).toBe('processed');

    const archivedDocument = await request(app.getHttpServer())
      .post(
        `/organizations/${organization.body.organizationId}/documents/${document.body.documentId}/archive`,
      )
      .set('Authorization', `Bearer ${sessionToken}`);

    expect(archivedDocument.status).toBe(200);
    expect(archivedDocument.body).toEqual({
      documentId: document.body.documentId,
      status: 'archived',
      archivedAt: expect.any(String),
    });

    const job = await request(app.getHttpServer())
      .post(`/organizations/${organization.body.organizationId}/jobs`)
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({ kind: 'document.process', maxAttempts: 2 });

    expect(job.status).toBe(201);
    expect(job.body).toEqual({
      jobId: expect.any(String),
      organizationId: organization.body.organizationId,
      kind: 'document.process',
      status: 'queued',
      attempts: 0,
      maxAttempts: 2,
    });

    const startedJob = await request(app.getHttpServer())
      .post(
        `/organizations/${organization.body.organizationId}/jobs/${job.body.jobId}/start`,
      )
      .set('Authorization', `Bearer ${sessionToken}`);
    expect(startedJob.status).toBe(200);
    expect(startedJob.body).toMatchObject({
      jobId: job.body.jobId,
      status: 'running',
      attempts: 1,
    });

    const completedJob = await request(app.getHttpServer())
      .post(
        `/organizations/${organization.body.organizationId}/jobs/${job.body.jobId}/complete`,
      )
      .set('Authorization', `Bearer ${sessionToken}`);
    expect(completedJob.status).toBe(200);
    expect(completedJob.body).toMatchObject({
      jobId: job.body.jobId,
      status: 'succeeded',
      attempts: 1,
    });

    const loggedOut = await request(app.getHttpServer())
      .post('/identity/logout')
      .set('Authorization', `Bearer ${sessionToken}`);

    expect(loggedOut.status).toBe(201);
    expect(loggedOut.body).toEqual({
      sessionId: loggedIn.body.sessionId,
      revoked: true,
    });

    const revokedSession = await request(app.getHttpServer())
      .get('/identity/me')
      .set('Authorization', `Bearer ${sessionToken}`);

    expect(revokedSession.status).toBe(401);

    const identityEventTypes = [
      'identity.registered.v1',
      'identity.verification.challenge.issued.v1',
      'identity.verified.v1',
      'identity.session.created.v1',
      'identity.session.revoked.v1',
    ];
    const organizationEventTypes = [
      'organization.created.v1',
      'organization.membership.added.v1',
    ];
    // Every event this identity caused, found in the outbox by its payload.
    const actorEventTypes = [
      ...identityEventTypes,
      ...organizationEventTypes,
      'document.created.v1',
      'document.archived.v1',
      'job.submitted.v1',
      'job.started.v1',
      'job.started.v1',
      'job.completed.v1',
      'job.completed.v1',
    ];
    // Audit files each event under the aggregate its module names on the
    // envelope, so only Identity's own events carry the identity subject.
    const identityEventTypesForSubject = identityEventTypes;
    const aggregateSubjects = await eventually(
      async () => request(app!.getHttpServer()).get('/audit/entries'),
      (response) =>
        response.status === 200 &&
        response.body.some(
          (entry: { eventType?: string; subject?: { kind?: string; id?: string } }) =>
            entry.eventType === 'organization.created.v1' &&
            entry.subject?.kind === 'organization' &&
            entry.subject.id === organization.body.organizationId,
        ) &&
        response.body.some(
          (entry: { eventType?: string; subject?: { kind?: string; id?: string } }) =>
            entry.eventType === 'organization.membership.added.v1' &&
            entry.subject?.kind === 'membership' &&
            entry.subject.id === organization.body.ownerMembershipId,
        ) &&
        response.body.some(
          (entry: { eventType?: string; subject?: { kind?: string; id?: string } }) =>
            entry.eventType === 'document.created.v1' &&
            entry.subject?.kind === 'document' &&
            entry.subject.id === document.body.documentId,
        ),
    );
    expect(aggregateSubjects.status).toBe(200);
    const eventTypes = actorEventTypes;
    const audit = await eventually(
      async () => {
        return request(app!.getHttpServer()).get('/audit/entries');
      },
      (response) =>
        response.status === 200 &&
        identityEventTypesForSubject.every((eventType) =>
          response.body.some(
            (entry: { eventType?: string; subject?: { id?: string } }) =>
              entry.eventType === eventType && entry.subject?.id === identityId,
          ),
        ),
    );

    const identityAudit = audit.body.filter(
      (entry: { subject?: { id?: string } }) =>
        entry.subject?.id === identityId,
    );
    expect(identityAudit).toHaveLength(identityEventTypesForSubject.length);
    expect(
      identityAudit
        .map((entry: { eventType: string }) => entry.eventType)
        .sort(),
    ).toEqual([...identityEventTypesForSubject].sort());

    const workflowAudit = await eventually(
      async () => {
        return request(app!.getHttpServer()).get('/audit/entries');
      },
      (response) =>
        response.status === 200 &&
        [
          'document.processing.started.v1',
          'document.processing.completed.v1',
        ].every((eventType) =>
          response.body.some(
            (entry: { eventType?: string; subject?: { id?: string } }) =>
              entry.eventType === eventType &&
              entry.subject?.id === document.body.documentId,
          ),
        ),
    );
    expect(
      workflowAudit.body.filter(
        (entry: { eventType?: string; subject?: { id?: string } }) =>
          entry.eventType === 'document.processing.started.v1' &&
          entry.subject?.id === document.body.documentId,
      ),
    ).toHaveLength(1);
    expect(
      workflowAudit.body.filter(
        (entry: { eventType?: string; subject?: { id?: string } }) =>
          entry.eventType === 'document.processing.completed.v1' &&
          entry.subject?.id === document.body.documentId,
      ),
    ).toHaveLength(1);

    const database = app.get<Database>(DATABASE);
    const persisted = await database.transaction(async (transaction) => {
      const outbox = await transaction.query<{
        state: string;
        event_type: string;
      }>(
        "SELECT state,(envelope::jsonb)->>'type' AS event_type FROM public.n2f_outbox WHERE (envelope::jsonb #>> '{payload,identity_id}')=$1 ORDER BY event_type",
        [identityId],
      );
      const entries = await transaction.query<{
        event_type: string;
        subject_id: string;
      }>(
        'SELECT event_type,subject_id::text FROM public.n2f_audit_entries WHERE subject_id=$1::uuid ORDER BY event_type',
        [identityId],
      );
      const organizations = await transaction.query<{
        id: string;
        name: string;
        slug: string;
        status: string;
      }>(
        'SELECT id::text,name,slug,status FROM public.n2f_organization_organizations WHERE id=$1::uuid',
        [organization.body.organizationId],
      );
      const memberships = await transaction.query<{
        id: string;
        organization_id: string;
        identity_id: string;
        role: string;
        status: string;
      }>(
        'SELECT id::text,organization_id::text,identity_id::text,role,status FROM public.n2f_organization_memberships WHERE id=$1::uuid',
        [organization.body.ownerMembershipId],
      );
      const documents = await transaction.query<{
        id: string;
        organization_id: string;
        name: string;
        storage_key: string | null;
        status: string;
      }>(
        'SELECT id::text,organization_id::text,name,storage_key,status FROM public.n2f_document_documents WHERE id=$1::uuid',
        [document.body.documentId],
      );
      const jobs = await transaction.query<{
        id: string;
        organization_id: string;
        kind: string;
        status: string;
        attempts: number;
        max_attempts: number;
        subject_type: string | null;
        subject_id: string | null;
      }>(
        'SELECT id::text,organization_id::text,kind,status,attempts,max_attempts,subject_type,subject_id::text FROM public.n2f_jobs_jobs WHERE id=$1::uuid',
        [job.body.jobId],
      );
      const workflowJobs = await transaction.query<{
        id: string;
        organization_id: string;
        kind: string;
        status: string;
        attempts: number;
        max_attempts: number;
        subject_type: string | null;
        subject_id: string | null;
      }>(
        'SELECT id::text,organization_id::text,kind,status,attempts,max_attempts,subject_type,subject_id::text FROM public.n2f_jobs_jobs WHERE id=$1::uuid',
        [processing.body.jobId],
      );
      return ok({
        outbox: outbox.rows,
        entries: entries.rows,
        organizations: organizations.rows,
        memberships: memberships.rows,
        documents: documents.rows,
        jobs: jobs.rows,
        workflowJobs: workflowJobs.rows,
      });
    });

    expect(persisted.ok).toBe(true);
    if (persisted.ok) {
      expect(persisted.value.outbox).toHaveLength(eventTypes.length);
      expect(
        persisted.value.outbox.every((event) => event.state === 'sent'),
      ).toBe(true);
      expect(persisted.value.outbox.map((event) => event.event_type)).toEqual(
        [...eventTypes].sort(),
      );
      expect(persisted.value.entries).toEqual(
        [...identityEventTypes]
          .sort()
          .map((event_type) => ({ event_type, subject_id: identityId })),
      );
      expect(persisted.value.organizations).toEqual([
        {
          id: organization.body.organizationId,
          name: 'Example Organization',
          slug: expect.stringMatching(/^n2f-[a-f0-9]{8}$/),
          status: 'active',
        },
      ]);
      expect(persisted.value.memberships).toEqual([
        {
          id: organization.body.ownerMembershipId,
          organization_id: organization.body.organizationId,
          identity_id: identityId,
          role: 'owner',
          status: 'active',
        },
      ]);
      expect(persisted.value.documents).toEqual([
        {
          id: document.body.documentId,
          organization_id: organization.body.organizationId,
          name: 'Durable contract.pdf',
          storage_key: 'documents/durable-contract.pdf',
          status: 'archived',
        },
      ]);
      expect(persisted.value.jobs).toEqual([
        {
          id: job.body.jobId,
          organization_id: organization.body.organizationId,
          kind: 'document.process',
          status: 'succeeded',
          attempts: 1,
          max_attempts: 2,
          subject_type: null,
          subject_id: null,
        },
      ]);
      expect(persisted.value.workflowJobs).toEqual([
        {
          id: processing.body.jobId,
          organization_id: organization.body.organizationId,
          kind: 'document.process',
          status: 'succeeded',
          attempts: 1,
          max_attempts: 2,
          subject_type: 'document',
          subject_id: document.body.documentId,
        },
      ]);
    }
  }, 20000);

  it('recovers after a transaction result becomes uncertain', async () => {
    if (!app) throw new Error('Nest application was not initialized');
    const database = app.get(DATABASE) as Database | undefined;
    expect(database).toBeDefined();
    if (!database) return;

    const faults = new FaultInjector();
    const chaotic = new ChaosTransactionDatabase(database, faults);
    faults.arm({
      point: 'database.transaction.after',
      action: 'fail',
      failure: failure(
        'unavailable',
        'test transaction acknowledgement was lost',
        { type: 'chaos.transaction_ack_lost' },
      ),
    });

    const uncertain = await chaotic.transaction(async (transaction) => {
      await transaction.query('SELECT 1');
      return ok('committed');
    });
    expect(uncertain.ok).toBe(false);

    const recovered = await chaotic.transaction(async (transaction) => {
      await transaction.query('SELECT 1');
      return ok('recovered');
    });
    expect(recovered).toEqual(ok('recovered'));
  });
});
