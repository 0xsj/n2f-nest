import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY, exhausted, retryDelay, type RetryPolicy } from './retry.js';

const policy: RetryPolicy = { maxAttempts: 4, baseMs: 100, maxMs: 1000 };

describe('retryDelay', () => {
  it('doubles the ceiling per attempt and jitters within its upper half', () => {
    expect(retryDelay(policy, 1, () => 0)).toBe(50);
    expect(retryDelay(policy, 1, () => 1)).toBe(100);
    expect(retryDelay(policy, 2, () => 0)).toBe(100);
    expect(retryDelay(policy, 3, () => 0.5)).toBe(300);
  });

  it('never exceeds maxMs', () => {
    expect(retryDelay(policy, 5, () => 1)).toBe(1000);
    expect(retryDelay(policy, 60, () => 1)).toBe(1000);
    expect(retryDelay(policy, 60, () => 0)).toBe(500);
  });

  it('treats attempts below one as the first', () => {
    expect(retryDelay(policy, 0, () => 1)).toBe(100);
    expect(retryDelay(policy, -3, () => 1)).toBe(100);
  });

  it('rounds down to whole milliseconds', () => {
    expect(retryDelay({ maxAttempts: 1, baseMs: 3, maxMs: 3 }, 1, () => 0)).toBe(1);
  });

  it('caps the exponent so large attempts stay finite without maxMs', () => {
    const unbounded = { maxAttempts: 1, baseMs: 1, maxMs: Number.POSITIVE_INFINITY };
    expect(retryDelay(unbounded, 1000, () => 1)).toBe(2 ** 30);
  });
});

describe('exhausted', () => {
  it('is exhausted from the last allowed attempt onward', () => {
    expect(exhausted(policy, 3)).toBe(false);
    expect(exhausted(policy, 4)).toBe(true);
    expect(exhausted(policy, 5)).toBe(true);
  });
});

describe('DEFAULT_RETRY', () => {
  it('waits 7 to 13.5 minutes in total before dead-lettering', () => {
    let longest = 0;
    let shortest = 0;
    for (let attempt = 1; attempt < DEFAULT_RETRY.maxAttempts; attempt += 1) {
      longest += retryDelay(DEFAULT_RETRY, attempt, () => 1);
      shortest += retryDelay(DEFAULT_RETRY, attempt, () => 0);
    }
    expect(shortest).toBe(405_750);
    expect(longest).toBe(811_500);
    expect(Object.isFrozen(DEFAULT_RETRY)).toBe(true);
  });
});
