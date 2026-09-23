import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpApplication } from '../src/app/http-application.js';
import { map } from '../src/shared/env/index.js';
import { parseRuntimeConfig } from '../src/platform/runtime/index.js';
import { eventually } from './support/eventually.js';
import { sequentially, tenants, type Tenant, type TenantIdentity } from './support/tenants.js';

/**
 * Tenant isolation for the example modules: no tenant can read or change
 * another tenant's documents or jobs (hardening items S5, S6, S8). A fork that
 * deletes Document and Jobs deletes this suite with them; the organization
 * and audit routes are covered by tenant-isolation.integration.spec.ts.
 */
describe('Tenant isolation (documents and jobs)', () => {
  let app: INestApplication | undefined;
  const { server, identity, tenant, as } = tenants(() => app!);

  let alpha: Tenant;
  let beta: Tenant;
  let member: TenantIdentity;
  let alphaDocument: string;
  let alphaJob: string;

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
    for (let index = 0; index < 3; index += 1) {
      const created = await as(alpha.token).post(`/organizations/${alpha.organizationId}/documents`, {
        name: `alpha-${index}.pdf`,
      });
      expect(created.status).toBe(201);
      alphaDocument = created.body.documentId;
    }
    const processing = await as(alpha.token).post(
      `/organizations/${alpha.organizationId}/documents/${alphaDocument}/process`,
    );
    expect(processing.status).toBe(201);
    alphaJob = processing.body.jobId;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('refuses every document and job route without a session', async () => {
    const routes = [
      `/organizations/${alpha.organizationId}/documents`,
      `/organizations/${alpha.organizationId}/jobs`,
      `/organizations/${alpha.organizationId}/documents/${alphaDocument}`,
    ];
    for (const route of routes) {
      expect((await request(server()).get(route)).status, route).toBe(401);
    }
  });

  it("refuses another organization's owner on the victim's routes", async () => {
    const intruder = as(beta.token);
    const base = `/organizations/${alpha.organizationId}`;
    const attempts = await sequentially([
      () => intruder.get(`${base}/documents`),
      () => intruder.get(`${base}/documents/${alphaDocument}`),
      () => intruder.get(`${base}/jobs`),
      () => intruder.post(`${base}/documents`, { name: 'planted.pdf' }),
      () => intruder.post(`${base}/documents/${alphaDocument}/archive`),
      () => intruder.post(`${base}/documents/${alphaDocument}/process`),
      () => intruder.post(`${base}/jobs/${alphaJob}/cancel`),
    ]);
    for (const response of attempts) {
      expect([401, 403], `${response.req.method} ${response.req.path}`).toContain(response.status);
    }
  });

  it("finds no victim resource through the intruder's own organization", async () => {
    const intruder = as(beta.token);
    const base = `/organizations/${beta.organizationId}`;
    const attempts = await sequentially([
      () => intruder.get(`${base}/documents/${alphaDocument}`),
      () => intruder.post(`${base}/documents/${alphaDocument}/archive`),
      () => intruder.post(`${base}/documents/${alphaDocument}/process`),
      () => intruder.post(`${base}/jobs/${alphaJob}/cancel`),
    ]);
    for (const response of attempts) {
      expect(response.status, `${response.req.method} ${response.req.path}`).toBe(404);
    }
    expect((await intruder.get(`${base}/documents`)).body).toEqual([]);
    expect((await intruder.get(`${base}/jobs`)).body).toEqual([]);
  });

  it("records the example modules' events in their own organization's audit trail only", async () => {
    const trail = await eventually(
      () => as(alpha.token).get(`/organizations/${alpha.organizationId}/audit/entries?limit=100`),
      (response) =>
        response.status === 200 &&
        response.body.some((entry: { eventType: string }) => entry.eventType === 'job.submitted.v1'),
    );
    expect(trail.body.map((entry: { eventType: string }) => entry.eventType)).toEqual(
      expect.arrayContaining(['document.created.v1', 'job.submitted.v1']),
    );
    const betaTrail = await as(beta.token).get(`/organizations/${beta.organizationId}/audit/entries?limit=100`);
    expect(
      betaTrail.body.some((entry: { eventType: string }) => /^(document|job)\./.test(entry.eventType)),
    ).toBe(false);
  });

  it('lets plain members read documents', async () => {
    expect((await as(member.token).get(`/organizations/${alpha.organizationId}/documents`)).status).toBe(200);
  });

  it('pages lists with cursors bound to the list they came from', async () => {
    const owner = as(alpha.token);
    const base = `/organizations/${alpha.organizationId}`;
    const first = await owner.get(`${base}/documents?limit=2`);
    expect(first.body).toHaveLength(2);
    const cursor = first.headers['x-next-cursor'];
    expect(cursor).toEqual(expect.any(String));

    const second = await owner.get(`${base}/documents?limit=2&cursor=${cursor}`);
    expect(second.body).toHaveLength(1);
    expect(second.headers['x-next-cursor']).toBeUndefined();
    const ids = [...first.body, ...second.body].map((document: { documentId: string }) => document.documentId);
    expect(new Set(ids).size).toBe(3);

    expect((await owner.get(`${base}/jobs?cursor=${cursor}`)).status).toBe(400);
    expect((await as(beta.token).get(`/organizations/${beta.organizationId}/documents?cursor=${cursor}`)).status).toBe(400);
    expect((await owner.get(`${base}/documents?limit=500`)).status).toBe(400);
    expect((await owner.get(`${base}/documents?cursor=not-a-cursor`)).status).toBe(400);
  });
});
