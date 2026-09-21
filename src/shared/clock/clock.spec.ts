import { describe, expect, it } from 'vitest';
import { FakeClock, SystemClock } from './index.js';

describe('clock', () => {
  it('starts at the supplied wall instant with stable zero elapsed time', () => {
    const clock = new FakeClock(new Date(123));

    for (let i = 0; i < 2; i += 1) {
      expect(clock.now().getTime()).toBe(123);
      expect(clock.elapsed()).toBe(0n);
    }
  });

  it('advances wall and elapsed time together', () => {
    const clock = new FakeClock(new Date(0));

    clock.advance(123);
    expect(clock.now().getTime()).toBe(123);
    expect(clock.elapsed()).toBe(123000000n);

    clock.advance(0);
    expect(clock.elapsed()).toBe(123000000n);
  });

  it('keeps elapsed time stable across wall-clock correction', () => {
    const clock = new FakeClock(new Date(0));
    clock.advance(1000);

    for (const wall of [3600000, -3600000]) {
      clock.set(new Date(wall));
      expect(clock.now().getTime()).toBe(wall);
      expect(clock.elapsed()).toBe(1000000000n);
    }

    clock.advance(2000);
    expect(clock.now().getTime()).toBe(-3598000);
    expect(clock.elapsed()).toBe(3000000000n);
  });

  it('rejects invalid changes atomically', () => {
    const clock = new FakeClock(new Date(0));

    for (const duration of [
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => clock.advance(duration)).toThrow(RangeError);
      expect(clock.now().getTime()).toBe(0);
      expect(clock.elapsed()).toBe(0n);
    }

    expect(() => new FakeClock(new Date(NaN))).toThrow(RangeError);
    expect(() => clock.set(new Date(NaN))).toThrow(RangeError);
    expect(clock.now().getTime()).toBe(0);

    clock.set(new Date(8640000000000000));
    expect(() => clock.advance(1)).toThrow(RangeError);
    expect(clock.now().getTime()).toBe(8640000000000000);
    expect(clock.elapsed()).toBe(0n);
  });

  it('uses system wall time and monotonic elapsed time in production', () => {
    const clock = new SystemClock();
    const before = Date.now();
    const wall = clock.now().getTime();
    const after = Date.now();

    expect(wall).toBeGreaterThanOrEqual(before);
    expect(wall).toBeLessThanOrEqual(after);

    const first = clock.elapsed();
    expect(first).toBeGreaterThanOrEqual(0n);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(first);
  });

  it('owns Date values crossing the fake boundary', () => {
    const input = new Date(123);
    const clock = new FakeClock(input);

    input.setTime(999);
    clock.now().setTime(999);
    expect(clock.now().getTime()).toBe(123);

    const next = new Date(456);
    clock.set(next);
    next.setTime(999);
    expect(clock.now().getTime()).toBe(456);
  });
});
