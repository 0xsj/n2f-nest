/**
 * Identity application query: session authentication (CONTRACT.md U08).
 * The resolver owns the transactional recheck and idle extension; this layer
 * digests the token, supplies time and the idle TTL, and projects the result.
 * @module modules/identity/app/query
 */
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import { isTime, MAX_TIME_MS } from '../../domain/bounds.js';
import type { TokenDigest, TokenPurpose } from '../../domain/token.js';

/** Safe admission projection: IDs and the admitted epoch, never email, hash or token. */
export type AuthenticatedPrincipal = Readonly<{
  principalId: ID;
  sessionId: ID;
  authEpoch: number;
}>;
export type Resolution =
  | Readonly<{
      outcome: 'admitted';
      principalId: ID;
      sessionId: ID;
      authEpoch: number;
    }>
  | Readonly<{ outcome: 'rejected' }>
  | Readonly<{ outcome: 'absent' }>;
export interface Clock {
  now(): Date;
}
export interface TokenDigester {
  digest(
    purpose: TokenPurpose,
    secret: SecretString,
  ): Result<TokenDigest, Failure>;
}
export interface SessionResolver {
  resolve(
    digest: TokenDigest,
    nowMs: number,
    idleTtlMs: number,
  ): Promise<Result<Resolution, Failure>>;
}
export type QueryPorts = Readonly<{
  clock: Clock;
  digester: TokenDigester;
  resolver: SessionResolver;
}>;
export type QueryConfig = Readonly<{ sessionIdleMs: number }>;
export type AuthenticateInput = Readonly<{ token: SecretString }>;

const sessionRejected = (): Failure =>
  failure('unauthenticated', 'session rejected', {
    type: 'identity.session_rejected',
  });
const dependencyFailed = (cause?: unknown): Failure =>
  failure('unavailable', 'authentication dependency failed', {
    type: 'identity.auth_dependency_failed',
    cause,
  });

export class Authenticate {
  readonly #ports: QueryPorts;
  readonly #idleTtlMs: number;
  private constructor(ports: QueryPorts, idleTtlMs: number) {
    this.#ports = ports;
    this.#idleTtlMs = idleTtlMs;
    Object.freeze(this);
  }
  static create(
    ports: QueryPorts,
    config: QueryConfig,
  ): Result<Authenticate, Failure> {
    const ttl = config?.sessionIdleMs;
    if (
      typeof ttl !== 'number' ||
      !Number.isSafeInteger(ttl) ||
      ttl <= 0 ||
      ttl > MAX_TIME_MS
    )
      return err(
        failure('invalid', 'invalid authentication configuration', {
          type: 'identity.auth_configuration',
        }),
      );
    return ok(new Authenticate(ports, ttl));
  }
  /** Malformed, absent and rejected tokens are indistinguishable to the caller (U08). */
  async execute(
    input: AuthenticateInput,
  ): Promise<Result<AuthenticatedPrincipal, Failure>> {
    const { clock, digester, resolver } = this.#ports;
    let now: number;
    try {
      now = clock.now().getTime();
    } catch (cause) {
      return err(dependencyFailed(cause));
    }
    if (!isTime(now)) return err(dependencyFailed());
    const digest = digester.digest('session', input.token);
    if (!digest.ok) return err(sessionRejected());
    const resolved = await resolver.resolve(digest.value, now, this.#idleTtlMs);
    if (!resolved.ok) return resolved;
    const r = resolved.value;
    if (r.outcome !== 'admitted') return err(sessionRejected());
    return ok({
      principalId: r.principalId,
      sessionId: r.sessionId,
      authEpoch: r.authEpoch,
    });
  }
}
