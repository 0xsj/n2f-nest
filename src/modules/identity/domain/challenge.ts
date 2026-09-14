import {
  err,
  ok,
  failure,
  type Result,
  type Failure,
} from '../../../shared/errors/index.js';
import { parse, type ID } from '../../../shared/id/index.js';
import { TokenDigest, type TokenPurpose } from './token.js';
import { isOptionalTime, isRecord, isTime, isVersion } from './bounds.js';
export type ChallengeSnapshot = {
  id: ID;
  principalId: ID;
  tokenDigest: TokenDigest;
  passwordVersion: number;
  issuedAtMs: number;
  expiresAtMs: number;
  consumedAtMs?: number;
  invalidatedAtMs?: number;
};
const invalid = () =>
  failure('invalid', 'invalid challenge', {
    type: 'identity.challenge_invalid',
  });
const rejected = () =>
  failure('unauthenticated', 'challenge rejected', {
    type: 'identity.challenge_rejected',
  });
const normalize = (s: ChallengeSnapshot): ChallengeSnapshot | undefined => {
  if (!isRecord(s)) return undefined;
  const id = parse(s.id),
    principal = parse(s.principalId);
  if (
    !id.ok ||
    !principal.ok ||
    !TokenDigest.valid(s.tokenDigest) ||
    !['email_verification', 'password_reset'].includes(
      s.tokenDigest.purpose(),
    ) ||
    !isVersion(s.passwordVersion) ||
    !isTime(s.issuedAtMs) ||
    !isTime(s.expiresAtMs) ||
    s.expiresAtMs <= s.issuedAtMs ||
    !isOptionalTime(s.consumedAtMs) ||
    !isOptionalTime(s.invalidatedAtMs) ||
    (s.consumedAtMs !== undefined &&
      (s.consumedAtMs < s.issuedAtMs || s.consumedAtMs >= s.expiresAtMs)) ||
    (s.invalidatedAtMs !== undefined && s.invalidatedAtMs < s.issuedAtMs)
  )
    return undefined;
  return {
    id: id.value,
    principalId: principal.value,
    tokenDigest: s.tokenDigest,
    passwordVersion: s.passwordVersion,
    issuedAtMs: s.issuedAtMs,
    expiresAtMs: s.expiresAtMs,
    ...(s.consumedAtMs === undefined ? {} : { consumedAtMs: s.consumedAtMs }),
    ...(s.invalidatedAtMs === undefined
      ? {}
      : { invalidatedAtMs: s.invalidatedAtMs }),
  };
};
/** Single-use mail challenge value; storage alone guarantees one winner. */
export class Challenge {
  readonly #state: Readonly<ChallengeSnapshot>;
  private constructor(state: ChallengeSnapshot) {
    this.#state = Object.freeze({ ...state });
  }
  static issue(
    id: ID,
    principalId: ID,
    digest: TokenDigest,
    version: number,
    issued: number,
    expires: number,
  ): Result<Challenge, Failure> {
    return Challenge.restore({
      id,
      principalId,
      tokenDigest: digest,
      passwordVersion: version,
      issuedAtMs: issued,
      expiresAtMs: expires,
    });
  }
  static restore(s: ChallengeSnapshot): Result<Challenge, Failure> {
    const state = normalize(s);
    return state === undefined ? err(invalid()) : ok(new Challenge(state));
  }
  snapshot(): ChallengeSnapshot {
    return { ...this.#state };
  }
  consume(
    purpose: TokenPurpose,
    version: number,
    now: number,
  ): Result<Challenge, Failure> {
    const s = normalize(this.#state);
    if (s === undefined || !isTime(now)) return err(invalid());
    if (purpose !== s.tokenDigest.purpose()) return err(rejected());
    if (version !== s.passwordVersion) return err(rejected());
    if (s.consumedAtMs !== undefined || s.invalidatedAtMs !== undefined)
      return err(rejected());
    if (now < s.issuedAtMs || now >= s.expiresAtMs) return err(rejected());
    return ok(new Challenge({ ...s, consumedAtMs: now }));
  }
  /** Idempotent; preserves consumption and the first invalidation time. */
  invalidate(now: number): Result<Challenge, Failure> {
    const s = normalize(this.#state);
    if (s === undefined || !isTime(now) || now < s.issuedAtMs)
      return err(invalid());
    if (s.invalidatedAtMs !== undefined) return ok(new Challenge(s));
    return ok(new Challenge({ ...s, invalidatedAtMs: now }));
  }
}
