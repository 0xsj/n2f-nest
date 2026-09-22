import { describe, expect, it } from 'vitest';
import { FakeClock } from '../clock/index.js';
import { failure, ok, type Result } from '../errors/index.js';
import type {
  RateLimitConsumeInput,
  RateLimitDecision,
  RateLimitStore,
} from './index.js';
import { RateLimiter } from './index.js';

class TestStore implements RateLimitStore {
  input: RateLimitConsumeInput | undefined;

  consume(input: RateLimitConsumeInput): Result<RateLimitDecision, ReturnType<typeof failure>> {
    this.input = input;
    return ok({
      allowed: true,
      limit: input.rule.limit,
      remaining: input.rule.limit - 1,
      resetAt: new Date(input.now.getTime() + input.rule.windowMs),
      retryAfterMs: 0,
    });
  }
}

describe('RateLimiter', () => {
  it('passes policy keys and clock time to the replaceable store', async () => {
    const clock = new FakeClock(new Date('2026-09-21T00:00:00.000Z'));
    const store = new TestStore();
    const limiter = new RateLimiter(store, clock);

    const result = await limiter.consume('identity.login:client', {
      limit: 10,
      windowMs: 60_000,
    });

    expect(result.ok).toBe(true);
    expect(store.input).toEqual({
      key: 'identity.login:client',
      rule: { limit: 10, windowMs: 60_000 },
      now: new Date('2026-09-21T00:00:00.000Z'),
    });
  });
});
