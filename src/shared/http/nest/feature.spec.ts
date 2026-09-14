import { All, Controller, Module, Req, Res } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Request, Response } from 'express';
import { createServer, type Server as NodeServer } from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SystemClock } from '../../clock/index.js';
import { V7 } from '../../id/index.js';
import { create as createLogger, type Runtime } from '../../logger/index.js';
import { err, failure, ok } from '../../errors/index.js';
import {
  Factory,
  actor,
  operation,
  type Scope,
} from '../../provenance/index.js';
import type { Completion } from '../lifecycle.js';
import { Reply } from '../index.js';
import { Server, type Route, type Config } from './server.js';
import type { Observer, Observation } from './observer.js';

type Finish = {
  route?: string;
  scope?: Scope;
  failure?: { error: unknown };
  completion: Completion;
};
class Recording implements Observer {
  readonly finishes: Finish[] = [];
  readonly starts: string[] = [];
  start(method: string): Observation {
    this.starts.push(method);
    return {
      run: (fn) => fn(),
      finish: (completion, route, scope, failure) => {
        this.finishes.push({ completion, route, scope, failure });
      },
    };
  }
}
const lines: string[] = [];
const admissions: string[] = [];
let http: NodeServer,
  app: INestApplication,
  logger: Runtime,
  base: string,
  observer: Recording,
  adapter: Server;
const ready = (ms: number) => new Promise((r) => setTimeout(r, ms));
beforeAll(async () => {
  const clock = new SystemClock(),
    ids = new V7(clock),
    factory = new Factory(clock, ids);
  const created = createLogger({
    resource: { name: 'feature-spec' },
    format: 'json',
    clock,
    sink: {
      write: (line) => {
        lines.push(line);
      },
    },
  });
  if (!created.ok) throw new Error('logger');
  logger = created.value;
  observer = new Recording();
  const executor = actor('service', 'feature-spec');
  if (!executor.ok) throw new Error('executor');
  const routes: Route[] = [
    {
      path: '/plain',
      operation: 'spec.plain.get',
      method: 'GET',
      handler: () => ok({ plain: 'get' }),
    },
    {
      path: '/plain',
      operation: 'spec.plain.post',
      method: 'POST',
      handler: () => ok({ plain: 'post' }),
    },
    {
      path: '/echo',
      operation: 'spec.echo',
      method: 'POST',
      handler: (context) => {
        const text = Buffer.from(context.request.body).toString('utf8');
        return Reply.create({
          status: 201,
          body: {
            bytes: context.request.body.byteLength,
            json: text ? JSON.parse(text) : null,
            origin: context.request.headers.origin,
            csrf: context.request.headers['x-csrf-token'],
            source: context.request.source,
            method: context.request.method,
            template: context.request.template,
          },
        });
      },
    },
    {
      path: '/login',
      operation: 'spec.login',
      method: 'POST',
      handler: () =>
        Reply.create({
          status: 204,
          headers: { 'Cache-Control': 'no-store' },
          cookies: [
            {
              name: '__Host-n2f_session',
              value: 'cookie-SENTINEL',
              path: '/',
              secure: true,
              httpOnly: true,
              sameSite: 'Lax',
              maxAge: 60,
            },
            {
              name: 'n2f_csrf',
              value: 'csrf-value',
              path: '/',
              secure: true,
              sameSite: 'Lax',
              maxAge: 60,
            },
          ],
        }),
    },
    {
      path: '/who',
      operation: 'spec.who',
      method: 'GET',
      admission: (request) => {
        admissions.push('admission');
        const who = request.cookies.get('who') ?? [];
        if (who.length > 1)
          return err(
            failure('invalid', 'duplicate who cookie', {
              type: 'spec.duplicate',
            }),
          );
        if (who.length === 0) return ok({ kind: 'anonymous' as const });
        if (who[0] === 'bad')
          return err(
            failure('unauthenticated', 'no', { type: 'spec.rejected' }),
          );
        if (who[0] === 'limited')
          return ok({
            kind: 'refused' as const,
            error: failure('rate_limited', 'slow down', {
              type: 'spec.limited',
            }),
            retryAfterSeconds: 7,
          });
        const initiator = actor('user', who[0]);
        if (!initiator.ok) return initiator;
        return ok({
          kind: 'authenticated' as const,
          initiator: initiator.value,
          admitted: { name: who[0] },
        });
      },
      handler: async (context) => {
        await ready(40);
        const snap = context.scope.snapshot();
        return ok({
          initiator: snap.work.attribution.initiator,
          admitted: context.request.admitted ?? null,
          cookies: [...context.request.cookies.keys()],
          dupes: context.request.cookies.get('dup') ?? [],
        });
      },
    },
    {
      path: '/unlisted',
      operation: 'spec.unlisted',
      method: 'GET',
      handler: () =>
        Reply.create({ status: 200, headers: { 'X-Custom': '1' } as never }),
    },
  ];
  const config: Config = {
    routes,
    observer,
    log: logger.log,
    now: () => clock.elapsed(),
    timeoutMs: 1000,
    maxBody: 64,
    maxActive: 8,
    open: (name, incoming, at) => {
      const op = operation(name);
      if (!op.ok) return op;
      return factory.enter(
        {
          origin: 'request',
          operation: op.value,
          attribution: at,
          executor: executor.value,
        },
        incoming,
      );
    },
  };
  adapter = new Server(config);
  @Controller()
  class SpecController {
    @All('{*path}')
    handle(@Req() req: Request, @Res() res: Response) {
      return adapter.handle(req, res);
    }
  }
  @Module({ controllers: [SpecController] })
  class SpecModule {}
  app = await NestFactory.create(SpecModule, {
    logger: false,
    bodyParser: false,
  });
  app.use(adapter.middleware);
  await app.init();
  http = createServer(app.getHttpAdapter().getInstance());
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  base =
    'http://127.0.0.1:' +
    (typeof address === 'object' && address ? address.port : 0);
});
afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await app.close();
  await logger.close(1000);
});
const last = () => observer.finishes[observer.finishes.length - 1];

describe('feature routes on the native adapter (H15–H18)', () => {
  it('matches method per template, serves HEAD for GET, and lists Allow on 405', async () => {
    expect(await (await fetch(base + '/plain')).json()).toEqual({
      plain: 'get',
    });
    expect(
      await (await fetch(base + '/plain', { method: 'POST' })).json(),
    ).toEqual({ plain: 'post' });
    const head = await fetch(base + '/plain', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const put = await fetch(base + '/plain', { method: 'PUT' });
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('GET, HEAD, POST');
    expect((await put.json()).code).toBe('http.method_not_allowed');
    expect(last().route).toBe('/plain');
    expect((await fetch(base + '/nowhere', { method: 'POST' })).status).toBe(
      404,
    );
  });
  it('hands a bounded JSON body, selected headers, cookies and source to the handler', async () => {
    const r = await fetch(base + '/echo', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://app.example',
        'x-csrf-token': 't1',
      },
      body: '{"a":1}',
    });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({
      bytes: 7,
      json: { a: 1 },
      origin: ['https://app.example'],
      csrf: ['t1'],
      source: '127.0.0.1',
      method: 'POST',
      template: '/echo',
    });
    const empty = await fetch(base + '/echo', { method: 'POST' });
    expect(empty.status).toBe(201);
    expect((await empty.json()).bytes).toBe(0);
    const text = await fetch(base + '/echo', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x',
    });
    expect(text.status).toBe(415);
    const big = await fetch(base + '/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":"' + 'x'.repeat(100) + '"}',
    });
    expect(big.status).toBe(413);
  });
  it('writes a 204 with Set-Cookie and no-store, never logging the cookie value', async () => {
    const r = await fetch(base + '/login', { method: 'POST' });
    expect(r.status).toBe(204);
    expect(await r.text()).toBe('');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.getSetCookie()).toEqual([
      '__Host-n2f_session=cookie-SENTINEL; Path=/; Max-Age=60; Secure; HttpOnly; SameSite=Lax',
      'n2f_csrf=csrf-value; Path=/; Max-Age=60; Secure; SameSite=Lax',
    ]);
    expect(r.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(last().completion.facts.status).toBe(204);
    expect(last().completion.classification.outcome).toBe('success');
  });
  it('runs admission once, before the scope opens, and projects refusals with observation', async () => {
    admissions.length = 0;
    const anon = await fetch(base + '/who');
    expect(anon.status).toBe(200);
    expect((await anon.json()).initiator).toEqual({ kind: 'anonymous' });
    expect(admissions).toEqual(['admission']);
    const rejected = await fetch(base + '/who', {
      headers: { cookie: 'who=bad' },
    });
    expect(rejected.status).toBe(401);
    expect((await rejected.json()).code).toBe('spec.rejected');
    expect(last().route).toBe('/who');
    expect(last().completion.classification.outcome).toBe('refused');
    expect(last().scope?.snapshot().work.operation).toBe('http.admission');
    const limited = await fetch(base + '/who', {
      headers: { cookie: 'who=limited' },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('7');
    const dupes = await fetch(base + '/who', {
      headers: { cookie: 'who=ada; dup=1; dup=2' },
    });
    expect(await dupes.json()).toMatchObject({
      initiator: { kind: 'user', identity: 'ada' },
      admitted: { name: 'ada' },
      dupes: ['1', '2'],
    });
    const duplicate = await fetch(base + '/who', {
      headers: { cookie: 'who=ada; who=bob' },
    });
    expect(duplicate.status).toBe(400);
    admissions.length = 0;
    expect((await fetch(base + '/who', { method: 'DELETE' })).status).toBe(405);
    expect((await fetch(base + '/whom')).status).toBe(404);
    expect(admissions).toEqual([]);
  });
  it('keeps overlapping authenticated and anonymous requests in separate scopes', async () => {
    const [a, b, c] = await Promise.all([
      fetch(base + '/who', { headers: { cookie: 'who=ada' } }).then((r) =>
        r.json(),
      ),
      fetch(base + '/who').then((r) => r.json()),
      fetch(base + '/who', { headers: { cookie: 'who=bob' } }).then((r) =>
        r.json(),
      ),
    ]);
    expect(a.initiator).toEqual({ kind: 'user', identity: 'ada' });
    expect(b.initiator).toEqual({ kind: 'anonymous' });
    expect(c.initiator).toEqual({ kind: 'user', identity: 'bob' });
  });
  it('refuses an unlisted response header as a handler error before commitment', async () => {
    const r = await fetch(base + '/unlisted');
    expect(r.status).toBe(500);
    expect(r.headers.get('x-custom')).toBeNull();
    expect(last().completion.classification.outcome).toBe('failed');
  });
  it('never places cookie or header values in completion logs', async () => {
    await fetch(base + '/login', {
      method: 'POST',
      headers: {
        cookie: 'who=log-SENTINEL',
        origin: 'https://origin-SENTINEL',
      },
    });
    await logger.close(1000);
    const completed = lines.filter((l) => l.includes('http.request.completed'));
    expect(completed.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('SENTINEL');
  });
});
