import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpApplication } from '../src/app/http-application.js';
import { map } from '../src/shared/env/index.js';
import { parseRuntimeConfig } from '../src/platform/runtime/index.js';
import { eventually } from './support/eventually.js';
import { sequentially, tenants, type Tenant, type TenantIdentity } from './support/tenants.js';

/**
 * No tenant can read or change another tenant's organization, memberships or
 * audit trail through any route (hardening items S5, S6, S8). Two
 * organizations, each with its own owner, plus a plain member in the first.
 * The example modules have their own suite
 * (document-tenant-isolation.integration.spec.ts). Memory mode needs no
 * infrastructure, so this suite always runs.
 */
describe('Tenant isolation', () => {
  let app: INestApplication | undefined;
  const { server, identity, tenant, as } = tenants(() => app!);

  let alpha: Tenant;
  let beta: Tenant;
  let member: TenantIdentity;
  let alphaInvitation: string;

  /** Alpha's audit trail once it holds at least `count` entries. */
  const alphaTrail = (count: number) =>
    eventually(
      () => as(alpha.token).get(`/organizations/${alpha.organizationId}/audit/entries?limit=100`),
      (response) => response.status === 200 && response.body.length >= count,
    );

  beforeAll(async () => {
    const parsed = parseRuntimeConfig(map({ N2F_STORAGE: 'memory', N2F_EVENT_TRANSPORT: 'local' }));
    if (!parsed.ok) throw new Error(parsed.error.message);
    app = await createHttpApplication(parsed.value, { logger: false });
    // Listen once: supertest otherwise binds and closes a listener per
    // request, which intermittently resets connections under load.
    await app.listen(0, '127.0.0.1');

    alpha = await tenant();
    beta = await tenant();
    member = await identity();
    const added = await as(alpha.token).post(`/organizations/${alpha.organizationId}/memberships`, {
      identityId: member.identityId,
      role: 'member',
    });
    expect(added.status).toBe(201);
    const invitee = await identity();
    const invited = await as(alpha.token).post(`/organizations/${alpha.organizationId}/invitations`, {
      identityId: invitee.identityId,
      role: 'member',
    });
    expect(invited.status).toBe(201);
    alphaInvitation = invited.body.invitationId;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('refuses every tenant route without a session', async () => {
    const base = `/organizations/${alpha.organizationId}`;
    const attempts = await sequentially([
      () => request(server()).get('/organizations'),
      () => request(server()).get(`${base}/audit/entries`),
      () => request(server()).post(`${base}/memberships`).send({ identityId: member.identityId, role: 'admin' }),
      () => request(server()).post(`${base}/invitations`).send({ identityId: member.identityId, role: 'member' }),
      () => request(server()).patch(`${base}/memberships/${alpha.ownerMembershipId}/role`).send({ role: 'member' }),
      () => request(server()).delete(`${base}/memberships/${alpha.ownerMembershipId}`),
      () => request(server()).delete(`${base}/invitations/${alphaInvitation}`),
    ]);
    for (const response of attempts) {
      expect(response.status, `${response.req.method} ${response.req.path}`).toBe(401);
    }
  });

  it("refuses another organization's owner on the victim's routes", async () => {
    const intruder = as(beta.token);
    const base = `/organizations/${alpha.organizationId}`;
    const attempts = await sequentially([
      () => intruder.get(`${base}/audit/entries`),
      () => intruder.patch(`${base}/memberships/${alpha.ownerMembershipId}/role`, { role: 'member' }),
      () => intruder.delete(`${base}/memberships/${alpha.ownerMembershipId}`),
      () => intruder.post(`${base}/memberships`, { identityId: beta.identityId, role: 'admin' }),
      () => intruder.post(`${base}/invitations`, { identityId: beta.identityId, role: 'admin' }),
      () => intruder.delete(`${base}/invitations/${alphaInvitation}`),
    ]);
    for (const response of attempts) {
      expect([401, 403], `${response.req.method} ${response.req.path}`).toContain(response.status);
    }
  });

  it("finds no victim resource through the intruder's own organization", async () => {
    const intruder = as(beta.token);
    const base = `/organizations/${beta.organizationId}`;
    const attempts = await sequentially([
      () => intruder.patch(`${base}/memberships/${alpha.ownerMembershipId}/role`, { role: 'member' }),
      () => intruder.delete(`${base}/memberships/${alpha.ownerMembershipId}`),
      () => intruder.delete(`${base}/invitations/${alphaInvitation}`),
    ]);
    for (const response of attempts) {
      expect(response.status, `${response.req.method} ${response.req.path}`).toBe(404);
    }
    const listed = await intruder.get('/organizations');
    expect(listed.body.map((organization: { organizationId: string }) => organization.organizationId)).toEqual([
      beta.organizationId,
    ]);
  });

  it("shows each owner only their own organization's audit trail", async () => {
    const trail = await alphaTrail(3);

    expect(trail.body.map((entry: { eventType: string }) => entry.eventType)).toEqual(
      expect.arrayContaining([
        'organization.created.v1',
        'organization.membership.added.v1',
        'organization.invitation.created.v1',
      ]),
    );
    const betaTrail = await as(beta.token).get(`/organizations/${beta.organizationId}/audit/entries?limit=100`);
    expect(betaTrail.status).toBe(200);
    const alphaEventIds = new Set(trail.body.map((entry: { eventId: string }) => entry.eventId));
    expect(betaTrail.body.some((entry: { eventId: string }) => alphaEventIds.has(entry.eventId))).toBe(false);
    expect(trail.body.some((entry: { eventType: string }) => entry.eventType.startsWith('identity.'))).toBe(false);
  });

  it('keeps the audit trail from plain members', async () => {
    const audit = await as(member.token).get(`/organizations/${alpha.organizationId}/audit/entries`);
    expect(audit.status).toBe(403);
    expect(audit.body.code).toBe('audit.access_forbidden');
  });

  it('pages lists with cursors bound to the list they came from', async () => {
    const total = (await alphaTrail(3)).body.length as number;
    const owner = as(alpha.token);
    const base = `/organizations/${alpha.organizationId}/audit/entries`;
    const first = await owner.get(`${base}?limit=1`);
    expect(first.body).toHaveLength(1);
    const cursor = first.headers['x-next-cursor'];
    expect(cursor).toEqual(expect.any(String));

    const rest = await owner.get(`${base}?limit=100&cursor=${cursor}`);
    expect(rest.body).toHaveLength(total - 1);
    expect(rest.headers['x-next-cursor']).toBeUndefined();
    const ids = [...first.body, ...rest.body].map((entry: { eventId: string }) => entry.eventId);
    expect(new Set(ids).size).toBe(total);

    expect((await as(beta.token).get(`/organizations/${beta.organizationId}/audit/entries?cursor=${cursor}`)).status).toBe(400);
    expect((await owner.get(`${base}?limit=500`)).status).toBe(400);
    expect((await owner.get(`${base}?cursor=not-a-cursor`)).status).toBe(400);
  });
});
