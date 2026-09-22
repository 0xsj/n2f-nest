import type { WallClock } from '../clock/index.js';
import type { Failure, Result } from '../errors/index.js';

/** A policy shared by transports without carrying any HTTP or auth language. */
export type RateLimitRule = Readonly<{
  limit: number;
  windowMs: number;
}>;

export type RateLimitDecision = Readonly<{
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfterMs: number;
}>;

export type RateLimitConsumeInput = Readonly<{
  key: string;
  rule: RateLimitRule;
  now: Date;
}>;

/** Storage seam for an in-memory, Redis, database or gateway implementation. */
export interface RateLimitStore {
  consume(
    input: RateLimitConsumeInput,
  ): Result<RateLimitDecision, Failure> | Promise<Result<RateLimitDecision, Failure>>;
}

/** Framework-free rate-limit coordinator. Policy and storage remain replaceable. */
export class RateLimiter {
  constructor(
    private readonly store: RateLimitStore,
    private readonly clock: WallClock,
  ) {}

  consume(
    key: string,
    rule: RateLimitRule,
  ): Promise<Result<RateLimitDecision, Failure>> {
    return Promise.resolve(this.store.consume({ key, rule, now: this.clock.now() }));
  }
}
