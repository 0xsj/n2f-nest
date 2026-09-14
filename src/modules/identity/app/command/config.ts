import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { MAX_TIME_MS } from '../../domain/bounds.js';

/** Product defaults (U02): explicit blueprint choices, not compliance claims. */
export type Config = Readonly<{
  sessionAbsoluteMs: number;
  sessionIdleMs: number;
  verificationTtlMs: number;
  resetTtlMs: number;
}>;
export const DEFAULT_CONFIG: Config = Object.freeze({
  sessionAbsoluteMs: 12 * 3600_000,
  sessionIdleMs: 30 * 60_000,
  verificationTtlMs: 24 * 3600_000,
  resetTtlMs: 15 * 60_000,
});
export const configInvalid = (): Failure =>
  failure('invalid', 'invalid authentication configuration', {
    type: 'identity.auth_configuration',
  });
export const isDuration = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= MAX_TIME_MS;
export function validateConfig(c: Config): Result<Config, Failure> {
  if (
    typeof c !== 'object' ||
    c === null ||
    !isDuration(c.sessionAbsoluteMs) ||
    !isDuration(c.sessionIdleMs) ||
    !isDuration(c.verificationTtlMs) ||
    !isDuration(c.resetTtlMs) ||
    c.sessionIdleMs > c.sessionAbsoluteMs
  )
    return err(configInvalid());
  return ok(Object.freeze({ ...c }));
}
