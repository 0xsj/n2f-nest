import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../shared/errors/index.js';
import type {
  RateLimitConsumeInput,
  RateLimitDecision,
  RateLimitStore,
} from '../../shared/ratelimit/index.js';

type WindowState = Readonly<{
  windowStartMs: number;
  count: number;
}>;

const MAX_KEY_LENGTH = 256;
const MAX_LIMIT = 1_000_000;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

function invalidConfiguration(message: string): Failure {
  return failure('invalid', message, { type: 'rate_limit.invalid_configuration' });
}

/** Process-local fixed-window store; replaceable by a shared Redis adapter. */
export class InMemoryRateLimitStore implements RateLimitStore {
  readonly #windows = new Map<string, WindowState>();

  consume(input: RateLimitConsumeInput): Result<RateLimitDecision, Failure> {
    if (
      typeof input.key !== 'string' ||
      input.key.length === 0 ||
      input.key.length > MAX_KEY_LENGTH
    ) {
      return err(invalidConfiguration('rate-limit key is invalid'));
    }

    if (
      !Number.isSafeInteger(input.rule.limit) ||
      input.rule.limit < 1 ||
      input.rule.limit > MAX_LIMIT ||
      !Number.isSafeInteger(input.rule.windowMs) ||
      input.rule.windowMs < 1_000 ||
      input.rule.windowMs > MAX_WINDOW_MS
    ) {
      return err(invalidConfiguration('rate-limit rule is invalid'));
    }

    const nowMs = input.now.getTime();
    if (!Number.isFinite(nowMs)) {
      return err(invalidConfiguration('rate-limit clock time is invalid'));
    }

    const windowStartMs =
      Math.floor(nowMs / input.rule.windowMs) * input.rule.windowMs;
    const key = `${input.key}:${input.rule.windowMs}:${input.rule.limit}`;
    const previous = this.#windows.get(key);
    const current =
      previous?.windowStartMs === windowStartMs
        ? previous
        : { windowStartMs, count: 0 };
    const count = current.count + 1;
    this.#windows.set(key, { windowStartMs, count });

    if (this.#windows.size > 10_000) {
      for (const [storedKey, state] of this.#windows) {
        if (state.windowStartMs + MAX_WINDOW_MS < nowMs) {
          this.#windows.delete(storedKey);
        }
      }
    }

    const resetAtMs = windowStartMs + input.rule.windowMs;
    const allowed = count <= input.rule.limit;
    return ok({
      allowed,
      limit: input.rule.limit,
      remaining: Math.max(0, input.rule.limit - count),
      resetAt: new Date(resetAtMs),
      retryAfterMs: allowed ? 0 : Math.max(0, resetAtMs - nowMs),
    });
  }
}
