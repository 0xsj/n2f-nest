import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../shared/errors/index.js';
import type {
  RateLimitConsumeInput,
  RateLimitDecision,
  RateLimitStore,
} from '../../../shared/ratelimit/index.js';
import { map, type TransactionDatabase } from '../../../shared/postgres/index.js';

const MAX_KEY_LENGTH = 256;
const MAX_LIMIT = 1_000_000;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

function invalidConfiguration(message: string): Failure {
  return failure('invalid', message, { type: 'rate_limit.invalid_configuration' });
}

function validate(input: RateLimitConsumeInput): Result<number, Failure> {
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
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    return err(invalidConfiguration('rate-limit clock time is invalid'));
  }

  return ok(nowMs);
}

/** Atomic fixed-window buckets for multi-process PostgreSQL deployments. */
export class PostgresRateLimitStore implements RateLimitStore {
  #operations = 0;

  constructor(private readonly database: TransactionDatabase) {}

  async consume(
    input: RateLimitConsumeInput,
  ): Promise<Result<RateLimitDecision, Failure>> {
    const valid = validate(input);
    if (!valid.ok) return valid;

    const nowMs = valid.value;
    const windowStartMs =
      Math.floor(nowMs / input.rule.windowMs) * input.rule.windowMs;
    const result = await this.database.transaction(async (transaction) => {
      try {
        const row = (
          await transaction.query<{ count: number }>(
            `INSERT INTO public.n2f_rate_limits
              (bucket_key,window_start_ms,window_ms,rule_limit,count)
             VALUES ($1,$2,$3,$4,1)
             ON CONFLICT (bucket_key,window_start_ms,window_ms,rule_limit)
             DO UPDATE SET count=public.n2f_rate_limits.count+1
             RETURNING count`,
            [
              input.key,
              windowStartMs,
              input.rule.windowMs,
              input.rule.limit,
            ],
          )
        ).rows[0];
        if (!row) {
          return err(
            failure('internal', 'rate-limit bucket was not returned', {
              type: 'rate_limit.persistence_invalid',
            }),
          );
        }

        this.#operations += 1;
        if (this.#operations % 1000 === 0) {
          await transaction.query(
            'DELETE FROM public.n2f_rate_limits WHERE window_start_ms < $1',
            [nowMs - MAX_WINDOW_MS],
          );
        }

        const resetAtMs = windowStartMs + input.rule.windowMs;
        const allowed = row.count <= input.rule.limit;
        return ok({
          allowed,
          limit: input.rule.limit,
          remaining: Math.max(0, input.rule.limit - row.count),
          resetAt: new Date(resetAtMs),
          retryAfterMs: allowed ? 0 : Math.max(0, resetAtMs - nowMs),
        });
      } catch (cause) {
        return err(map(cause));
      }
    });
    return result;
  }
}
