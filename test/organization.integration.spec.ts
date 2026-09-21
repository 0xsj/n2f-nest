import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

const enabled = process.env.N2F_RUN_ORGANIZATION_INTEGRATION === '1';
const integration = enabled ? describe : describe.skip;

integration('Organization runtime integration', () => {
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

  it('creates an organization for the authenticated identity and projects its events', async () => {
    if (!app) throw new Error('Nest application was not initialized');

    const email = `organization-${randomUUID()}@example.com`;
    const password = 'correct horse battery staple';
    const server = app.getHttpServer();

    const registered = await request(server)
      .post('/identity/register')
      .send({ email, password });
    expect(registered.status).toBe(201);

    const challenged = await request(server)
      .post('/identity/verification-challenges')
      .send({ identityId: registered.body.identityId });
    expect(challenged.status).toBe(201);

    const verified = await request(server)
      .post('/identity/verify')
      .send({
        challengeId: challenged.body.challengeId,
        token: challenged.body.token,
      });
    expect(verified.status).toBe(201);

    const loggedIn = await request(server)
      .post('/identity/login')
      .send({ email, password });
    expect(loggedIn.status).toBe(201);

    const created = await request(server)
      .post('/organizations')
      .set('Authorization', `Bearer ${loggedIn.body.token}`)
      .send({ name: 'Signals Artist Agency', slug: 'signals-agency' });

    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      organizationId: expect.any(String),
      ownerMembershipId: expect.any(String),
    });

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

    const ownerRoleChange = await request(server)
      .patch(
        `/organizations/${created.body.organizationId}/memberships/${created.body.ownerMembershipId}/role`,
      )
      .set('Authorization', `Bearer ${loggedIn.body.token}`)
      .send({ role: 'admin' });

    expect(ownerRoleChange.status).toBe(403);

    const targetEmail = `organization-member-${randomUUID()}@example.com`;
    const targetRegistered = await request(server)
      .post('/identity/register')
      .send({ email: targetEmail, password: 'correct horse battery staple' });
    expect(targetRegistered.status).toBe(201);

    const targetChallenge = await request(server)
      .post('/identity/verification-challenges')
      .send({ identityId: targetRegistered.body.identityId });
    expect(targetChallenge.status).toBe(201);

    const targetVerified = await request(server)
      .post('/identity/verify')
      .send({
        challengeId: targetChallenge.body.challengeId,
        token: targetChallenge.body.token,
      });
    expect(targetVerified.status).toBe(201);

    const invitedEmail = `organization-invited-${randomUUID()}@example.com`;
    const invitedRegistered = await request(server)
      .post('/identity/register')
      .send({ email: invitedEmail, password: 'correct horse battery staple' });
    expect(invitedRegistered.status).toBe(201);

    const invitedChallenge = await request(server)
      .post('/identity/verification-challenges')
      .send({ identityId: invitedRegistered.body.identityId });
    expect(invitedChallenge.status).toBe(201);

    const invitedVerified = await request(server)
      .post('/identity/verify')
      .send({
        challengeId: invitedChallenge.body.challengeId,
        token: invitedChallenge.body.token,
      });
    expect(invitedVerified.status).toBe(201);

    const invitation = await request(server)
      .post(`/organizations/${created.body.organizationId}/invitations`)
      .set('Authorization', `Bearer ${loggedIn.body.token}`)
      .send({ identityId: invitedRegistered.body.identityId, role: 'member' });

    expect(invitation.status).toBe(201);
    expect(invitation.body).toEqual({
      invitationId: expect.any(String),
      identityId: invitedRegistered.body.identityId,
      role: 'member',
      status: 'pending',
      expiresAt: expect.any(String),
    });

    const invitedLogin = await request(server)
      .post('/identity/login')
      .send({
        email: invitedEmail,
        password: 'correct horse battery staple',
      });
    expect(invitedLogin.status).toBe(201);

    const accepted = await request(server)
      .post(
        `/organizations/${created.body.organizationId}/invitations/${invitation.body.invitationId}/accept`,
      )
      .set('Authorization', `Bearer ${invitedLogin.body.token}`);

    expect(accepted.status).toBe(201);
    expect(accepted.body).toEqual({
      invitationId: invitation.body.invitationId,
      membershipId: expect.any(String),
      organizationId: created.body.organizationId,
      identityId: invitedRegistered.body.identityId,
      role: 'member',
    });

    const invitedOrganizations = await request(server)
      .get('/organizations')
      .set('Authorization', `Bearer ${invitedLogin.body.token}`);

    expect(invitedOrganizations.status).toBe(200);
    expect(invitedOrganizations.body).toEqual([
      {
        organizationId: created.body.organizationId,
        name: 'Signals Artist Agency',
        slug: 'signals-agency',
        status: 'active',
        membershipId: accepted.body.membershipId,
        role: 'member',
        membershipStatus: 'active',
      },
    ]);

    const revokedInviteEmail = `organization-revoked-invite-${randomUUID()}@example.com`;
    const revokedInviteRegistered = await request(server)
      .post('/identity/register')
      .send({ email: revokedInviteEmail, password: 'correct horse battery staple' });
    expect(revokedInviteRegistered.status).toBe(201);

    const revokedInviteChallenge = await request(server)
      .post('/identity/verification-challenges')
      .send({ identityId: revokedInviteRegistered.body.identityId });
    expect(revokedInviteChallenge.status).toBe(201);

    const revokedInviteVerified = await request(server)
      .post('/identity/verify')
      .send({
        challengeId: revokedInviteChallenge.body.challengeId,
        token: revokedInviteChallenge.body.token,
      });
    expect(revokedInviteVerified.status).toBe(201);

    const pendingInvitation = await request(server)
      .post(`/organizations/${created.body.organizationId}/invitations`)
      .set('Authorization', `Bearer ${loggedIn.body.token}`)
      .send({ identityId: revokedInviteRegistered.body.identityId, role: 'member' });
    expect(pendingInvitation.status).toBe(201);

    const revokedInvitation = await request(server)
      .delete(
        `/organizations/${created.body.organizationId}/invitations/${pendingInvitation.body.invitationId}`,
      )
      .set('Authorization', `Bearer ${loggedIn.body.token}`);

    expect(revokedInvitation.status).toBe(200);
    expect(revokedInvitation.body).toEqual({
      invitationId: pendingInvitation.body.invitationId,
      status: 'revoked',
    });

    const added = await request(server)
      .post(`/organizations/${created.body.organizationId}/memberships`)
      .set('Authorization', `Bearer ${loggedIn.body.token}`)
      .send({ identityId: targetRegistered.body.identityId, role: 'member' });

    expect(added.status).toBe(201);
    expect(added.body).toEqual({
      membershipId: expect.any(String),
      identityId: targetRegistered.body.identityId,
      role: 'member',
    });

    const promoted = await request(server)
      .patch(
        `/organizations/${created.body.organizationId}/memberships/${added.body.membershipId}/role`,
      )
      .set('Authorization', `Bearer ${loggedIn.body.token}`)
      .send({ role: 'admin' });

    expect(promoted.status).toBe(200);
    expect(promoted.body).toEqual({
      membershipId: added.body.membershipId,
      role: 'admin',
    });

    const listed = await request(server)
      .get('/organizations')
      .set('Authorization', `Bearer ${loggedIn.body.token}`);

    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      {
        organizationId: created.body.organizationId,
        name: 'Signals Artist Agency',
        slug: 'signals-agency',
        status: 'active',
        membershipId: created.body.ownerMembershipId,
        role: 'owner',
        membershipStatus: 'active',
      },
    ]);

    const targetLogin = await request(server)
      .post('/identity/login')
      .send({
        email: targetEmail,
        password: 'correct horse battery staple',
      });
    expect(targetLogin.status).toBe(201);

    const targetOrganizations = await request(server)
      .get('/organizations')
      .set('Authorization', `Bearer ${targetLogin.body.token}`);

    expect(targetOrganizations.status).toBe(200);
    expect(targetOrganizations.body).toEqual([
      {
        organizationId: created.body.organizationId,
        name: 'Signals Artist Agency',
        slug: 'signals-agency',
        status: 'active',
        membershipId: added.body.membershipId,
        role: 'admin',
        membershipStatus: 'active',
      },
    ]);

    const ownerRevocation = await request(server)
      .delete(
        `/organizations/${created.body.organizationId}/memberships/${created.body.ownerMembershipId}`,
      )
      .set('Authorization', `Bearer ${loggedIn.body.token}`);

    expect(ownerRevocation.status).toBe(403);

    const revoked = await request(server)
      .delete(
        `/organizations/${created.body.organizationId}/memberships/${added.body.membershipId}`,
      )
      .set('Authorization', `Bearer ${loggedIn.body.token}`);

    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({
      membershipId: added.body.membershipId,
      status: 'revoked',
    });

    const targetOrganizationsAfterRevocation = await request(server)
      .get('/organizations')
      .set('Authorization', `Bearer ${targetLogin.body.token}`);

    expect(targetOrganizationsAfterRevocation.status).toBe(200);
    expect(targetOrganizationsAfterRevocation.body).toEqual([]);

    const audit = await request(server).get('/audit/entries');
    expect(audit.status).toBe(200);

    const organizationEvents = audit.body.filter(
      (entry: { eventType?: string }) =>
      entry.eventType === 'organization.created.v1' ||
      entry.eventType === 'organization.membership.added.v1' ||
      entry.eventType === 'organization.invitation.created.v1' ||
      entry.eventType === 'organization.invitation.accepted.v1' ||
      entry.eventType === 'organization.invitation.revoked.v1' ||
      entry.eventType === 'document.created.v1' ||
      entry.eventType === 'document.archived.v1' ||
      entry.eventType === 'job.submitted.v1' ||
      entry.eventType === 'job.started.v1' ||
      entry.eventType === 'job.failed.v1' ||
      entry.eventType === 'job.retried.v1' ||
      entry.eventType === 'job.completed.v1' ||
      entry.eventType === 'job.canceled.v1' ||
      entry.eventType === 'organization.membership.role.changed.v1' ||
      entry.eventType === 'organization.membership.revoked.v1',
    );

    expect(organizationEvents).toHaveLength(20);
    expect(organizationEvents.filter(
      (entry: { eventType: string }) => entry.eventType === 'organization.created.v1',
    )).toHaveLength(1);
    expect(organizationEvents.filter(
      (entry: { eventType: string }) => entry.eventType === 'organization.membership.added.v1',
    )).toHaveLength(3);
    expect(organizationEvents.filter(
      (entry: { eventType: string }) => entry.eventType === 'organization.invitation.created.v1',
    )).toHaveLength(2);
    expect(organizationEvents.filter(
      (entry: { eventType: string }) => entry.eventType === 'organization.invitation.accepted.v1',
    )).toHaveLength(1);
    expect(organizationEvents.filter(
      (entry: { eventType: string }) => entry.eventType === 'organization.invitation.revoked.v1',
    )).toHaveLength(1);
    expect(organizationEvents.filter(
      (entry: { eventType: string }) => entry.eventType === 'document.created.v1',
    )).toHaveLength(1);
    expect(organizationEvents.filter(
      (entry: { eventType: string }) => entry.eventType === 'document.archived.v1',
    )).toHaveLength(1);
    expect(organizationEvents.filter(
      (entry: { eventType: string }) => entry.eventType === 'job.submitted.v1',
    )).toHaveLength(2);
    expect(organizationEvents.filter(
      (entry: { eventType: string }) => entry.eventType === 'job.started.v1',
    )).toHaveLength(2);
    expect(organizationEvents.filter(
      (entry: { eventType: string }) => entry.eventType === 'job.failed.v1',
    )).toHaveLength(1);
    expect(organizationEvents.filter(
      (entry: { eventType: string }) => entry.eventType === 'job.retried.v1',
    )).toHaveLength(1);
    expect(organizationEvents.filter(
      (entry: { eventType: string }) => entry.eventType === 'job.completed.v1',
    )).toHaveLength(1);
    expect(organizationEvents.filter(
      (entry: { eventType: string }) => entry.eventType === 'job.canceled.v1',
    )).toHaveLength(1);
    expect(organizationEvents.filter(
      (entry: { eventType: string }) => entry.eventType === 'organization.membership.role.changed.v1',
    )).toHaveLength(1);
    expect(organizationEvents.filter(
      (entry: { eventType: string }) => entry.eventType === 'organization.membership.revoked.v1',
    )).toHaveLength(1);
    expect(organizationEvents.every(
      (entry: { subject?: { kind?: string; id?: string } }) =>
        entry.subject?.kind === 'identity',
    )).toBe(true);
  });
});
