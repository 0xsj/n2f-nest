import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type * as p from '../../../../shared/provenance/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import { isTime } from '../../domain/bounds.js';
import type { TokenDigest } from '../../domain/token.js';
import type { AttemptLimiter, Clock, IDSource } from './ports.js';

/** Failure vocabulary (A22, U01, U03). Messages stay generic; no private data. */
export const dependencyFailed = (cause?: unknown): Failure =>
  failure('unavailable', 'authentication dependency failed', {
    type: 'identity.auth_dependency_failed',
    cause,
  });
export const credentialsRejected = (): Failure =>
  failure('unauthenticated', 'credentials rejected', {
    type: 'identity.credentials_rejected',
  });
export const challengeRejected = (): Failure =>
  failure('unauthenticated', 'challenge rejected', {
    type: 'identity.challenge_rejected',
  });
export const sessionRejected = (): Failure =>
  failure('unauthenticated', 'session rejected', {
    type: 'identity.session_rejected',
  });
export const versionConflict = (): Failure =>
  failure('conflict', 'authentication state changed', {
    type: 'identity.version_conflict',
  });
export const versionExhausted = (): Failure =>
  failure('conflict', 'version exhausted', {
    type: 'identity.version_exhausted',
  });
export const passwordNotAllowed = (): Failure =>
  failure('invalid', 'password not allowed', {
    type: 'identity.password_invalid',
  });
export const rateLimited = (retryAfterMs: number): Failure =>
  failure('rate_limited', 'too many attempts', {
    type: 'identity.auth_rate_limited',
    fields: { retry_after_ms: String(retryAfterMs) },
  });

/** Wall time read once per operation (U01); an out-of-range reading is a dependency failure. */
export function nowMs(clock: Clock): Result<number, Failure> {
  let ms: number;
  try {
    ms = clock.now().getTime();
  } catch (cause) {
    return err(dependencyFailed(cause));
  }
  return isTime(ms) ? ok(ms) : err(dependencyFailed());
}
export function newId(ids: IDSource): Result<ID, Failure> {
  const r = ids.newId();
  return r.ok ? r : err(dependencyFailed(r.error));
}
export async function admit(
  limiter: AttemptLimiter,
  operation: string,
  subject: SecretString,
  source: string,
): Promise<Result<void, Failure>> {
  const r = await limiter.admit(operation, subject, source);
  if (!r.ok) return r;
  return r.value.permitted
    ? ok(undefined)
    : err(rateLimited(r.value.retryAfterMs));
}
/** Post-commit mail is bounded best effort (A15): a rejection is "not delivered". */
export async function deliver(send: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await send()) === true;
  } catch {
    return false;
  }
}
/** Safe event payloads (U14): stable IDs, enums and versions only. */
export type Payload = Readonly<Record<string, string | number>>;
export function event(
  ids: IDSource,
  work: p.WorkContext,
  occurredAtMs: number,
  type: string,
  payload: Payload,
): Result<Envelope, Failure> {
  const id = newId(ids);
  if (!id.ok) return id;
  return Envelope.create(id.value, type, occurredAtMs, work, payload);
}
export const digestSubject = (digest: TokenDigest): string =>
  Buffer.from(digest.bytes()).toString('hex');
export function nextVersion(current: number): Result<number, Failure> {
  return current >= 2147483647 ? err(versionExhausted()) : ok(current + 1);
}
