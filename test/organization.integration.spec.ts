import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { eventually } from './support/eventually.js';
import { mailbox, verificationFrom } from './support/mail.js';

const enabled = process.env.N2F_RUN_ORGANIZATION_INTEGRATION === '1';
const integration = enabled ? describe : describe.skip;

integration('Organization runtime integration', () => {
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

  it('creates an organization for the authenticated identity and projects its events', async () => {
    if (!app) throw new Error('Nest application was not initialized');

    const email = `organization-${randomUUID()}@example.com`;
    const password = 'correct horse battery staple';
    const server = app.getHttpServer();

    const registered = await request(server)
      .post('/identity/register')
      .send({ email, password });
    expect(registered.status).toBe(202);

    const challenged = await request(server).get(mailbox(email));
    expect(challenged.status).toBe(200);

    const verified = await request(server)
      .post('/identity/verify')
      .send(verificationFrom(challenged.body[0]));
    expect(verified.status).toBe(201);

    const loggedIn = await request(server)
      .post('/identity/login')
      .send({ email, password });
    expect(loggedIn.status).toBe(201);

    const created = await request(server)
      .post('/organizations')
      .set('Authorization', `Bearer ${loggedIn.body.token}`)
      .send({ name: 'Example Organization', slug: 'n2f-agency' });

    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      organizationId: expect.any(String),
      ownerMembershipId: expect.any(String),
    });

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
    expect(targetRegistered.status).toBe(202);

    const targetChallenge = await request(server).get(mailbox(targetEmail));
    expect(targetChallenge.status).toBe(200);

    const targetVerified = await request(server)
      .post('/identity/verify')
      .send(verificationFrom(targetChallenge.body[0]));
    expect(targetVerified.status).toBe(201);

    const invitedEmail = `organization-invited-${randomUUID()}@example.com`;
    const invitedRegistered = await request(server)
      .post('/identity/register')
      .send({ email: invitedEmail, password: 'correct horse battery staple' });
    expect(invitedRegistered.status).toBe(202);

    const invitedChallenge = await request(server).get(mailbox(invitedEmail));
    expect(invitedChallenge.status).toBe(200);

    const invitedVerified = await request(server)
      .post('/identity/verify')
      .send(verificationFrom(invitedChallenge.body[0]));
    expect(invitedVerified.status).toBe(201);

    const invitation = await request(server)
      .post(`/organizations/${created.body.organizationId}/invitations`)
      .set('Authorization', `Bearer ${loggedIn.body.token}`)
      .send({ identityId: invitedVerified.body.identityId, role: 'member' });

    expect(invitation.status).toBe(201);
    expect(invitation.body).toEqual({
      invitationId: expect.any(String),
      identityId: invitedVerified.body.identityId,
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
      identityId: invitedVerified.body.identityId,
      role: 'member',
    });

    const invitedOrganizations = await request(server)
      .get('/organizations')
      .set('Authorization', `Bearer ${invitedLogin.body.token}`);

    expect(invitedOrganizations.status).toBe(200);
    expect(invitedOrganizations.body).toEqual([
      {
        organizationId: created.body.organizationId,
        name: 'Example Organization',
        slug: 'n2f-agency',
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
    expect(revokedInviteRegistered.status).toBe(202);

    const revokedInviteChallenge = await request(server).get(mailbox(revokedInviteEmail));
    expect(revokedInviteChallenge.status).toBe(200);

    const revokedInviteVerified = await request(server)
      .post('/identity/verify')
      .send(verificationFrom(revokedInviteChallenge.body[0]));
    expect(revokedInviteVerified.status).toBe(201);

    const pendingInvitation = await request(server)
      .post(`/organizations/${created.body.organizationId}/invitations`)
      .set('Authorization', `Bearer ${loggedIn.body.token}`)
      .send({ identityId: revokedInviteVerified.body.identityId, role: 'member' });
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
      .send({ identityId: targetVerified.body.identityId, role: 'member' });

    expect(added.status).toBe(201);
    expect(added.body).toEqual({
      membershipId: expect.any(String),
      identityId: targetVerified.body.identityId,
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
        name: 'Example Organization',
        slug: 'n2f-agency',
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
        name: 'Example Organization',
        slug: 'n2f-agency',
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

    const organizationEventTypes = new Set([
      'organization.created.v1',
      'organization.membership.added.v1',
      'organization.invitation.created.v1',
      'organization.invitation.accepted.v1',
      'organization.invitation.revoked.v1',
      'organization.membership.role.changed.v1',
      'organization.membership.revoked.v1',
    ]);
    const audit = await eventually(
      () => request(server).get('/audit/entries'),
      (response) =>
        response.body.filter((entry: { eventType?: string }) =>
          organizationEventTypes.has(entry.eventType ?? ''),
        ).length >= 10,
    );
    expect(audit.status).toBe(200);

    const organizationEvents = audit.body.filter(
      (entry: { eventType?: string }) =>
      entry.eventType === 'organization.created.v1' ||
      entry.eventType === 'organization.membership.added.v1' ||
      entry.eventType === 'organization.invitation.created.v1' ||
      entry.eventType === 'organization.invitation.accepted.v1' ||
      entry.eventType === 'organization.invitation.revoked.v1' ||
      entry.eventType === 'organization.membership.role.changed.v1' ||
      entry.eventType === 'organization.membership.revoked.v1',
    );

    expect(organizationEvents).toHaveLength(10);
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
      (entry: { eventType: string }) => entry.eventType === 'organization.membership.role.changed.v1',
    )).toHaveLength(1);
    expect(organizationEvents.filter(
      (entry: { eventType: string }) => entry.eventType === 'organization.membership.revoked.v1',
    )).toHaveLength(1);
    // Each event is audited under the aggregate its module names, never under
    // the identity that acted.
    const expectedKind = (eventType: string) =>
      eventType.startsWith('organization.membership.')
        ? 'membership'
        : eventType.startsWith('organization.invitation.')
          ? 'invitation'
          : eventType.split('.')[0];
    expect(
      organizationEvents.filter(
        (entry: { eventType: string; subject?: { kind?: string } }) =>
          entry.subject?.kind !== expectedKind(entry.eventType),
      ),
    ).toEqual([]);
  });
});
