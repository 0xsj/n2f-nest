import { hrtime } from 'node:process';

/** A wall timestamp describing when an observation occurred. */
export interface WallClock {
  now(): Date;
}

/** A monotonic reading for measuring elapsed time within one clock instance. */
export interface MonotonicClock {
  elapsed(): bigint;
}

/** The complete clock capability. Consumers should depend on narrower views. */
export interface Clock extends WallClock, MonotonicClock {}

/** Production wall time and monotonic nanoseconds from a private origin. */
export class SystemClock implements Clock {
  readonly #origin = hrtime.bigint();

  now(): Date {
    return new Date();
  }

  elapsed(): bigint {
    return hrtime.bigint() - this.#origin;
  }
}

function validMillis(value: Date): number {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError('clock: invalid wall time');
  }
  return milliseconds;
}

/** Manually controlled within one JavaScript isolate. */
export class FakeClock implements Clock {
  #wall: number;
  #elapsed = 0n;

  constructor(start: Date) {
    this.#wall = validMillis(start);
  }

  now(): Date {
    return new Date(this.#wall);
  }

  elapsed(): bigint {
    return this.#elapsed;
  }

  set(wall: Date): void {
    this.#wall = validMillis(wall);
  }

  /** Whole nonnegative milliseconds; a refused advance changes neither reading. */
  advance(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new RangeError('clock: invalid advance');
    }

    const wall = this.#wall + milliseconds;
    if (!Number.isSafeInteger(wall) || Math.abs(wall) > 8640000000000000) {
      throw new RangeError('clock: invalid advance');
    }

    this.#wall = wall;
    this.#elapsed += BigInt(milliseconds) * 1000000n;
  }
}
