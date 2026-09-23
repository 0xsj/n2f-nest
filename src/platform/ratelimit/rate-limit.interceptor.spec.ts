import { HttpException, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../shared/clock/index.js';
import { RateLimiter } from '../../shared/ratelimit/index.js';
import { InMemoryRateLimitStore } from './in-memory-store.js';
import { RateLimit, type HttpRateLimitPolicy } from './policy.js';
import { RateLimitInterceptor } from './rate-limit.interceptor.js';

type Sent = Record<string, string>;

function harness(...policies: [HttpRateLimitPolicy, ...HttpRateLimitPolicy[]]) {
  class Target {
    @RateLimit(...policies)
    handle(): void {}
  }
  const clock = new FakeClock(new Date('2026-09-23T00:00:00.000Z'));
  const interceptor = new RateLimitInterceptor(
    new Reflector(),
    new RateLimiter(new InMemoryRateLimitStore(), clock),
  );
  const call = async (body: Record<string, string>) => {
    const headers: Sent = {};
    const request = { ip: '203.0.113.9', body } as unknown as Request;
    const context = {
      getHandler: () => Target.prototype.handle,
      getClass: () => Target,
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({
          setHeader: (name: string, value: string) => {
            headers[name] = value;
          },
        }),
      }),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of('handled') };
    try {
      await firstValueFrom(interceptor.intercept(context, next));
      return { status: 200, headers, body: undefined };
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      return { status: error.getStatus(), headers, body: error.getResponse() };
    }
  };
  return { call };
}

const byAccount: HttpRateLimitPolicy = {
  name: 'test.account',
  limit: 3,
  windowMs: 60_000,
  key: (request) => String(request.body.email),
};

const byClient: HttpRateLimitPolicy = {
  name: 'test.client',
  limit: 2,
  windowMs: 60_000,
  key: (request) => request.ip ?? 'unknown',
};

describe('RateLimitInterceptor', () => {
  it('refuses once any attached policy is exhausted and names that policy', async () => {
    const { call } = harness(byAccount, byClient);

    expect((await call({ email: 'a' })).status).toBe(200);
    expect((await call({ email: 'b' })).status).toBe(200);
    const refused = await call({ email: 'c' });

    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({
      code: 'rate_limit.exceeded',
      fields: { policy: 'test.client' },
    });
    expect(refused.headers['Retry-After']).toBe('60');
  });

  it('reports the policy with the fewest remaining requests', async () => {
    const { call } = harness(byAccount, byClient);

    const first = await call({ email: 'a' });

    expect(first.headers['X-RateLimit-Limit']).toBe('2');
    expect(first.headers['X-RateLimit-Remaining']).toBe('1');
  });

  it('leaves unannotated handlers alone', async () => {
    const interceptor = new RateLimitInterceptor(
      new Reflector(),
      new RateLimiter(new InMemoryRateLimitStore(), new FakeClock(new Date())),
    );
    class Plain {
      handle(): void {}
    }
    const context = {
      getHandler: () => Plain.prototype.handle,
      getClass: () => Plain,
    } as unknown as ExecutionContext;

    await expect(
      firstValueFrom(interceptor.intercept(context, { handle: () => of('ok') })),
    ).resolves.toBe('ok');
  });
});
