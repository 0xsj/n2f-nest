import {
  err,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type * as p from '../../../../shared/provenance/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import { AuthState } from '../../domain/auth-state.js';
import { Challenge } from '../../domain/challenge.js';
import { NewPassword } from '../../domain/password.js';
import { validateConfig, type Config } from './config.js';
import type {
  AttemptLimiter,
  ChallengeReader,
  Clock,
  EnrollmentPolicy,
  IDSource,
  PasswordHasherPort,
  PasswordStore,
  TokenCodecPort,
} from './ports.js';
import {
  admit,
  challengeRejected,
  digestSubject,
  event,
  nextVersion,
  nowMs,
  passwordNotAllowed,
} from './shared.js';

export type ResetPasswordPorts = Readonly<{
  clock: Clock;
  ids: IDSource;
  hasher: PasswordHasherPort;
  codec: TokenCodecPort;
  policy: EnrollmentPolicy;
  limiter: AttemptLimiter;
  store: ChallengeReader & PasswordStore;
}>;
export type ResetPasswordInput = Readonly<{
  token: SecretString;
  newPassword: SecretString;
  source: string;
  work: p.WorkContext;
}>;
export type ResetPasswordResult = Readonly<{
  done: true;
  principalId: ID;
  passwordVersion: number;
}>;

/** Recovery proves mailbox control and replaces the password; no session is issued (U13). */
export class ResetPassword {
  readonly #ports: ResetPasswordPorts;
  private constructor(ports: ResetPasswordPorts) {
    this.#ports = ports;
    Object.freeze(this);
  }
  static create(
    ports: ResetPasswordPorts,
    config: Config,
  ): Result<ResetPassword, Failure> {
    const c = validateConfig(config);
    return c.ok ? ok(new ResetPassword(ports)) : c;
  }
  async execute(
    input: ResetPasswordInput,
  ): Promise<Result<ResetPasswordResult, Failure>> {
    const { clock, ids, hasher, codec, policy, limiter, store } = this.#ports;
    const now = nowMs(clock);
    if (!now.ok) return now;
    const digest = codec.digest('password_reset', input.token);
    if (!digest.ok) return err(challengeRejected());
    const admission = await admit(
      limiter,
      'reset',
      new SecretString(digestSubject(digest.value)),
      input.source,
    );
    if (!admission.ok) return admission;
    const found = await store.findByDigest('password_reset', digest.value);
    if (!found.ok) return found;
    if (found.value === undefined) return err(challengeRejected());
    const { challenge, credential, authEpoch } = found.value;
    const next = NewPassword.parse(input.newPassword);
    if (!next.ok) return next;
    const allowed = await policy.checkBlocklist(next.value);
    if (!allowed.ok) return allowed;
    if (!allowed.value) return err(passwordNotAllowed());
    const restored = Challenge.restore(challenge);
    if (!restored.ok) return restored;
    const consumed = restored.value.consume(
      'password_reset',
      credential.passwordVersion,
      now.value,
    );
    if (!consumed.ok)
      return consumed.error.kind === 'unauthenticated'
        ? err(challengeRejected())
        : consumed;
    const hash = await hasher.hash(next.value);
    if (!hash.ok) return hash;
    const version = nextVersion(credential.passwordVersion);
    if (!version.ok) return version;
    const state = AuthState.create(credential.principalId, authEpoch);
    if (!state.ok) return state;
    const epoch = state.value.invalidate(authEpoch);
    if (!epoch.ok) return epoch;
    const changed = event(
      ids,
      input.work,
      now.value,
      'identity.password.changed.v1',
      {
        principal_id: credential.principalId,
        password_version: version.value,
        reason: 'reset',
      },
    );
    if (!changed.ok) return changed;
    const revoked = event(
      ids,
      input.work,
      now.value,
      'identity.sessions.revoked.v1',
      {
        principal_id: credential.principalId,
        auth_epoch: epoch.value.epoch(),
        reason: 'password_reset',
      },
    );
    if (!revoked.ok) return revoked;
    const outcome = await store.resetPassword({
      challengeId: challenge.id,
      principalId: credential.principalId,
      passwordHash: hash.value,
      consumedAtMs: now.value,
      changedAtMs: now.value,
      expectedPasswordVersion: credential.passwordVersion,
      expectedAuthEpoch: authEpoch,
      setVerified: credential.verifiedAtMs === undefined,
      events: [changed.value, revoked.value],
    });
    if (!outcome.ok) return outcome;
    if (outcome.value !== 'committed') return err(challengeRejected());
    return ok({
      done: true,
      principalId: credential.principalId,
      passwordVersion: version.value,
    });
  }
}
