import {
  err,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type * as p from '../../../../shared/provenance/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import { AuthState } from '../../domain/auth-state.js';
import { NewPassword, PasswordInput } from '../../domain/password.js';
import type { AuthenticatedPrincipal } from '../query/index.js';
import { validateConfig, type Config } from './config.js';
import type {
  AttemptLimiter,
  Clock,
  CredentialReader,
  EnrollmentPolicy,
  IDSource,
  PasswordHasherPort,
  PasswordStore,
} from './ports.js';
import {
  admit,
  credentialsRejected,
  event,
  nextVersion,
  nowMs,
  passwordNotAllowed,
  sessionRejected,
  versionConflict,
} from './shared.js';

export type ChangePasswordPorts = Readonly<{
  clock: Clock;
  ids: IDSource;
  hasher: PasswordHasherPort;
  policy: EnrollmentPolicy;
  limiter: AttemptLimiter;
  store: CredentialReader & PasswordStore;
}>;
export type ChangePasswordInput = Readonly<{
  caller: AuthenticatedPrincipal;
  currentPassword: SecretString;
  newPassword: SecretString;
  source: string;
  work: p.WorkContext;
}>;
export type ChangePasswordResult = Readonly<{
  done: true;
  passwordVersion: number;
  authEpoch: number;
  sessionsInvalidated: true;
}>;

/** Current-password proof, then replacement with version/epoch guards (U11, A14). */
export class ChangePassword {
  readonly #ports: ChangePasswordPorts;
  private constructor(ports: ChangePasswordPorts) {
    this.#ports = ports;
    Object.freeze(this);
  }
  static create(
    ports: ChangePasswordPorts,
    config: Config,
  ): Result<ChangePassword, Failure> {
    const c = validateConfig(config);
    return c.ok ? ok(new ChangePassword(ports)) : c;
  }
  async execute(
    input: ChangePasswordInput,
  ): Promise<Result<ChangePasswordResult, Failure>> {
    const { clock, ids, hasher, policy, limiter, store } = this.#ports;
    const now = nowMs(clock);
    if (!now.ok) return now;
    const current = PasswordInput.parse(input.currentPassword);
    if (!current.ok) return current;
    const next = NewPassword.parse(input.newPassword);
    if (!next.ok) return next;
    const { principalId, authEpoch } = input.caller;
    const admission = await admit(
      limiter,
      'password_change',
      new SecretString(principalId),
      input.source,
    );
    if (!admission.ok) return admission;
    const found = await store.findByPrincipal(principalId);
    if (!found.ok) return found;
    if (found.value === undefined) return err(sessionRejected());
    const { credential } = found.value;
    const matched = await hasher.verify(current.value, credential.passwordHash);
    if (!matched.ok) return matched;
    if (!matched.value) return err(credentialsRejected());
    const allowed = await policy.checkBlocklist(next.value);
    if (!allowed.ok) return allowed;
    if (!allowed.value) return err(passwordNotAllowed());
    const hash = await hasher.hash(next.value);
    if (!hash.ok) return hash;
    const version = nextVersion(credential.passwordVersion);
    if (!version.ok) return version;
    const state = AuthState.create(principalId, authEpoch);
    if (!state.ok) return state;
    const epoch = state.value.invalidate(authEpoch);
    if (!epoch.ok) return epoch;
    const changed = event(
      ids,
      input.work,
      now.value,
      'identity.password.changed.v1',
      {
        principal_id: principalId,
        password_version: version.value,
        reason: 'change',
      },
    );
    if (!changed.ok) return changed;
    const revoked = event(
      ids,
      input.work,
      now.value,
      'identity.sessions.revoked.v1',
      {
        principal_id: principalId,
        auth_epoch: epoch.value.epoch(),
        reason: 'password_change',
      },
    );
    if (!revoked.ok) return revoked;
    const outcome = await store.changePassword({
      principalId,
      passwordHash: hash.value,
      expectedPasswordVersion: credential.passwordVersion,
      expectedAuthEpoch: authEpoch,
      changedAtMs: now.value,
      events: [changed.value, revoked.value],
    });
    if (!outcome.ok) return outcome;
    if (outcome.value !== 'committed') return err(versionConflict());
    return ok({
      done: true,
      passwordVersion: version.value,
      authEpoch: epoch.value.epoch(),
      sessionsInvalidated: true,
    });
  }
}
