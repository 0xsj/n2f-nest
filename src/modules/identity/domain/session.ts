import {
  err,
  ok,
  failure,
  type Result,
  type Failure,
} from '../../../shared/errors/index.js';
import { parse, type ID } from '../../../shared/id/index.js';
import { TokenDigest } from './token.js';
import {
  MAX_TIME_MS,
  isOptionalTime,
  isRecord,
  isTime,
  isVersion,
} from './bounds.js';
export type SessionSnapshot = {
  id: ID;
  principalId: ID;
  tokenDigest: TokenDigest;
  authEpoch: number;
  issuedAtMs: number;
  lastSeenAtMs: number;
  absoluteExpiresAtMs: number;
  idleExpiresAtMs: number;
  revokedAtMs?: number;
};
const invalid = () =>
  failure('invalid', 'invalid session', { type: 'identity.session_invalid' });
const rejected = () =>
  failure('unauthenticated', 'session rejected', {
    type: 'identity.session_rejected',
  });
const normalize = (s: SessionSnapshot): SessionSnapshot | undefined => {
  if (!isRecord(s)) return undefined;
  const id = parse(s.id),
    principal = parse(s.principalId);
  if (
    !id.ok ||
    !principal.ok ||
    !TokenDigest.valid(s.tokenDigest) ||
    s.tokenDigest.purpose() !== 'session' ||
    !isVersion(s.authEpoch) ||
    !isTime(s.issuedAtMs) ||
    !isTime(s.lastSeenAtMs) ||
    !isTime(s.absoluteExpiresAtMs) ||
    !isTime(s.idleExpiresAtMs) ||
    !isOptionalTime(s.revokedAtMs) ||
    s.lastSeenAtMs < s.issuedAtMs ||
    s.absoluteExpiresAtMs <= s.issuedAtMs ||
    s.idleExpiresAtMs <= s.issuedAtMs ||
    s.idleExpiresAtMs < s.lastSeenAtMs ||
    s.idleExpiresAtMs > s.absoluteExpiresAtMs ||
    (s.revokedAtMs !== undefined && s.revokedAtMs < s.issuedAtMs)
  )
    return undefined;
  return {
    id: id.value,
    principalId: principal.value,
    tokenDigest: s.tokenDigest,
    authEpoch: s.authEpoch,
    issuedAtMs: s.issuedAtMs,
    lastSeenAtMs: s.lastSeenAtMs,
    absoluteExpiresAtMs: s.absoluteExpiresAtMs,
    idleExpiresAtMs: s.idleExpiresAtMs,
    ...(s.revokedAtMs === undefined ? {} : { revokedAtMs: s.revokedAtMs }),
  };
};
/** Opaque server-side session facts; eligibility of the principal is not checked here. */
export class Session {
  readonly #state: Readonly<SessionSnapshot>;
  private constructor(state: SessionSnapshot) {
    this.#state = Object.freeze({ ...state });
  }
  static issue(
    id: ID,
    principalId: ID,
    digest: TokenDigest,
    epoch: number,
    issued: number,
    absolute: number,
    idle: number,
  ): Result<Session, Failure> {
    return Session.restore({
      id,
      principalId,
      tokenDigest: digest,
      authEpoch: epoch,
      issuedAtMs: issued,
      lastSeenAtMs: issued,
      absoluteExpiresAtMs: absolute,
      idleExpiresAtMs: idle,
    });
  }
  static restore(s: SessionSnapshot): Result<Session, Failure> {
    const state = normalize(s);
    return state === undefined ? err(invalid()) : ok(new Session(state));
  }
  snapshot(): SessionSnapshot {
    return { ...this.#state };
  }
  /** Local validity only: revocation, backward time and both deadlines. */
  check(now: number): Result<void, Failure> {
    const s = normalize(this.#state);
    if (s === undefined || !isTime(now)) return err(invalid());
    if (s.revokedAtMs !== undefined) return err(rejected());
    if (now < s.lastSeenAtMs) return err(rejected());
    if (now >= s.idleExpiresAtMs || now >= s.absoluteExpiresAtMs)
      return err(rejected());
    return ok(undefined);
  }
  touch(now: number, idleTtl: number): Result<Session, Failure> {
    const s = normalize(this.#state);
    if (
      s === undefined ||
      !isTime(now) ||
      !Number.isSafeInteger(idleTtl) ||
      idleTtl < 1 ||
      idleTtl > MAX_TIME_MS
    )
      return err(invalid());
    const usable = this.check(now);
    if (!usable.ok) return usable;
    return ok(
      new Session({
        ...s,
        lastSeenAtMs: now,
        idleExpiresAtMs: Math.min(now + idleTtl, s.absoluteExpiresAtMs),
      }),
    );
  }
  /** Idempotent; keeps the first revocation time and never grants use. */
  revoke(now: number): Result<Session, Failure> {
    const s = normalize(this.#state);
    if (s === undefined || !isTime(now) || now < s.lastSeenAtMs)
      return err(invalid());
    if (s.revokedAtMs !== undefined) return ok(new Session(s));
    return ok(new Session({ ...s, revokedAtMs: now }));
  }
}
