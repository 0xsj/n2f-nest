import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../shared/clock/index.js';
import { InMemoryRateLimitStore } from './in-memory-store.js';

describe('InMemoryRateLimitStore', () => {
  it('allows up to the limit and denies until the window resets', () => {
    const clock = new FakeClock(new Date('2026-09-21T00:00:00.000Z'));
    const store = new InMemoryRateLimitStore();
    const rule = { limit: 2, windowMs: 60_000 };
    const consume = () =>
      store.consume({ key: 'client-a', rule, now: clock.now() });

    expect(consume()).toMatchObject({ ok: true, value: { allowed: true, remaining: 1 } });
    expect(consume()).toMatchObject({ ok: true, value: { allowed: true, remaining: 0 } });
    expect(consume()).toMatchObject({ ok: true, value: { allowed: false, retryAfterMs: 60_000 } });

    clock.advance(60_000);
    expect(consume()).toMatchObject({ ok: true, value: { allowed: true, remaining: 1 } });
  });

  it('returns a modeled configuration failure', () => {
    const result = new InMemoryRateLimitStore().consume({
      key: 'client-a',
      rule: { limit: 0, windowMs: 60_000 },
      now: new Date('2026-09-21T00:00:00.000Z'),
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          kind: 'invalid',
          type: 'rate_limit.invalid_configuration',
        }),
      }),
    );
  });
});
