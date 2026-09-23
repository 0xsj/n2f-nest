/**
 * Retry schedule for event delivery. Delays grow exponentially from `baseMs`
 * to `maxMs` with equal jitter (a delay between half the ceiling and the
 * ceiling), so consumers recovering from the same outage do not retry in
 * lockstep. After `maxAttempts` failed attempts a delivery is dead
 * and waits for an operator to requeue it.
 */
export type RetryPolicy = Readonly<{
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
}>;

/** 7 to 13.5 minutes of cumulative waiting (by jitter) before an event is dead-lettered. */
export const DEFAULT_RETRY: RetryPolicy = Object.freeze({
  maxAttempts: 12,
  baseMs: 500,
  maxMs: 5 * 60 * 1000,
});

/** Delay before retrying after failed attempt number `attempt` (1-based). */
export function retryDelay(
  policy: RetryPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** exponent);
  return Math.floor(ceiling / 2 + random() * (ceiling / 2));
}

/** Whether failed attempt number `attempt` exhausts the policy. */
export function exhausted(policy: RetryPolicy, attempt: number): boolean {
  return attempt >= policy.maxAttempts;
}
