import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { expect } from 'vitest';
import { mailbox, verificationFrom } from './mail.js';

/**
 * Verified identities and organizations created over HTTP, for suites that
 * check one tenant against another. Needs an application with the
 * development endpoints enabled (vitest.config.ts sets N2F_DEV_ENDPOINTS).
 */
export type TenantIdentity = Readonly<{ token: string; identityId: string; email: string; password: string }>;
export type Tenant = TenantIdentity & Readonly<{ organizationId: string; ownerMembershipId: string }>;

export function tenants(app: () => INestApplication) {
  const server = () => app().getHttpServer();

  async function identity(): Promise<TenantIdentity> {
    const email = `tenant-${randomUUID()}@example.com`;
    const password = 'correct horse battery staple';
    const registered = await request(server()).post('/identity/register').send({ email, password });
    expect(registered.status).toBe(202);
    const mail = await request(server()).get(mailbox(email));
    const verified = await request(server()).post('/identity/verify').send(verificationFrom(mail.body[0]));
    expect(verified.status).toBe(201);
    const login = await request(server()).post('/identity/login').send({ email, password });
    expect(login.status).toBe(201);
    return { token: login.body.token as string, identityId: login.body.identityId as string, email, password };
  }

  async function tenant(): Promise<Tenant> {
    const owner = await identity();
    const created = await request(server())
      .post('/organizations')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Tenant', slug: `t-${randomUUID().slice(0, 8)}` });
    expect(created.status).toBe(201);
    return {
      ...owner,
      organizationId: created.body.organizationId,
      ownerMembershipId: created.body.ownerMembershipId,
    };
  }

  const as = (token: string) => ({
    get: (path: string) => request(server()).get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) =>
      request(server()).post(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object = {}) =>
      request(server()).patch(path).set('Authorization', `Bearer ${token}`).send(body),
    delete: (path: string) => request(server()).delete(path).set('Authorization', `Bearer ${token}`),
  });

  return { server, identity, tenant, as };
}

/** Send requests one at a time; parallel supertest requests can reset connections. */
export async function sequentially<T>(requests: Array<() => PromiseLike<T>>): Promise<T[]> {
  const responses: T[] = [];
  for (const send of requests) responses.push(await send());
  return responses;
}
