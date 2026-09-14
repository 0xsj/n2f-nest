import { inspect } from 'node:util';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type { Digest } from '../../../../shared/keyed/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type {
  Admission,
  AttemptLimiter,
  Clock,
} from '../../app/command/index.js';

/** One fixed window: attempts allowed per windowMs. */
export type Window = Readonly<{ attempts: number; windowMs: number }>;
export type OperationLimits = Readonly<{ subject: Window; source?: Window }>;
export type LimiterConfig = Readonly<{
  operations: Readonly<Record<string, OperationLimits>>;
  /** Bound on distinct keys held in memory (L03). */
  maxKeys?: number;
}>;
const MINUTES_15 = 15 * 60_000;
const w = (attempts: number, windowMs = MINUTES_15): Window => ({
  attempts,
  windowMs,
});
/** Product defaults (L02); explicit blueprint choices, not production protection. */
export const DEFAULT_LIMITS: LimiterConfig = Object.freeze({
  operations: Object.freeze({
    register: { subject: w(5), source: w(30) },
    login: { subject: w(10), source: w(100) },
    verification_request: { subject: w(3), source: w(30) },
    reset_request: { subject: w(3), source: w(30) },
    verify: { subject: w(10) },
    reset: { subject: w(10) },
    password_change: { subject: w(5) },
  }),
  maxKeys: 100_000,
});
const configuration = (): Failure =>
  failure('invalid', 'invalid attempt limiter configuration', {
    type: 'identity.limiter_configuration',
  });
const dependencyFailed = (): Failure =>
  failure('unavailable', 'authentication dependency failed', {
    type: 'identity.auth_dependency_failed',
  });
const validWindow = (v: unknown): v is Window =>
  typeof v === 'object' &&
  v !== null &&
  Number.isSafeInteger((v as Window).attempts) &&
  (v as Window).attempts >= 1 &&
  Number.isSafeInteger((v as Window).windowMs) &&
  (v as Window).windowMs >= 1;
type Bucket = { count: number; startMs: number; windowMs: number };
export interface LocalLimiter extends AttemptLimiter {
  /** Operation names configured, sorted; for the root manifest. */
  operations(): string[];
  /** Safe view: key count only, never subjects or sources. */
  inspect(): { keys: number };
}
/**
 * ProcessLocalLimiter: fixed windows per keyed-digest bucket inside one process.
 * No protection across processes or restarts; stage 7 replaces it (L03).
 */
class ProcessLocalLimiter implements LocalLimiter {
  readonly #keyed: Digest;
  readonly #clock: Clock;
  readonly #config: LimiterConfig;
  readonly #maxKeys: number;
  readonly #buckets = new Map<string, Bucket>();
  constructor(keyed: Digest, clock: Clock, config: LimiterConfig) {
    this.#keyed = keyed;
    this.#clock = clock;
    this.#config = config;
    this.#maxKeys = config.maxKeys ?? 100_000;
    Object.freeze(this);
  }
  operations(): string[] {
    return Object.keys(this.#config.operations).sort();
  }
  inspect(): { keys: number } {
    return { keys: this.#buckets.size };
  }
  #key(operation: string, subject: string): Result<string, Failure> {
    const message = Buffer.concat([
      Buffer.from(operation, 'utf8'),
      Uint8Array.of(0),
      Buffer.from(subject, 'utf8'),
    ]);
    const tag = this.#keyed.sign('rate_limit', new Uint8Array(message));
    return tag.ok ? ok(Buffer.from(tag.value).toString('hex')) : tag;
  }
  #sweep(now: number): void {
    for (const [key, bucket] of this.#buckets)
      if (now >= bucket.startMs + bucket.windowMs) this.#buckets.delete(key);
  }
  #bucket(key: string, now: number, window: Window): Result<Bucket, Failure> {
    let bucket = this.#buckets.get(key);
    if (bucket && now >= bucket.startMs + bucket.windowMs) {
      this.#buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      if (this.#buckets.size >= this.#maxKeys) this.#sweep(now);
      if (this.#buckets.size >= this.#maxKeys) return err(dependencyFailed());
      bucket = { count: 0, startMs: now, windowMs: window.windowMs };
      this.#buckets.set(key, bucket);
    }
    return ok(bucket);
  }
  async admit(
    operation: string,
    subject: SecretString,
    source: string,
  ): Promise<Result<Admission, Failure>> {
    const limits = Object.hasOwn(this.#config.operations, operation)
      ? this.#config.operations[operation]
      : undefined;
    if (!limits) return err(configuration());
    let now: number;
    try {
      now = this.#clock.now().getTime();
    } catch {
      return err(dependencyFailed());
    }
    if (!Number.isSafeInteger(now) || now < 0) return err(dependencyFailed());
    const checks: Array<[Window, string]> = [
      [limits.subject, subject.reveal()],
    ];
    if (limits.source && source !== '') checks.push([limits.source, source]);
    let retryAfterMs = 0;
    for (const [window, raw] of checks) {
      const key = this.#key(operation, raw);
      if (!key.ok) return key;
      const bucket = this.#bucket(key.value, now, window);
      if (!bucket.ok) return bucket;
      if (bucket.value.count >= window.attempts)
        retryAfterMs = Math.max(
          retryAfterMs,
          bucket.value.startMs + bucket.value.windowMs - now,
        );
      bucket.value.count++;
    }
    return ok(
      retryAfterMs > 0
        ? { permitted: false, retryAfterMs }
        : { permitted: true },
    );
  }
  toJSON(): { keys: number } {
    return this.inspect();
  }
  [inspect.custom](): string {
    return 'ProcessLocalLimiter(keys=' + this.#buckets.size + ')';
  }
}
export function createLimiter(
  keyed: Digest,
  clock: Clock,
  config: LimiterConfig = DEFAULT_LIMITS,
): Result<LocalLimiter, Failure> {
  if (
    !keyed ||
    typeof keyed.sign !== 'function' ||
    !clock ||
    typeof clock.now !== 'function' ||
    typeof config !== 'object' ||
    config === null ||
    typeof config.operations !== 'object' ||
    config.operations === null ||
    Object.keys(config.operations).length === 0 ||
    (config.maxKeys !== undefined &&
      (!Number.isSafeInteger(config.maxKeys) || config.maxKeys < 1))
  )
    return err(configuration());
  for (const limits of Object.values(config.operations))
    if (
      !validWindow(limits?.subject) ||
      (limits.source !== undefined && !validWindow(limits.source))
    )
      return err(configuration());
  return ok(new ProcessLocalLimiter(keyed, clock, config));
}
