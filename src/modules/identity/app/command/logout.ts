import {
  err,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type * as p from '../../../../shared/provenance/index.js';
import { AuthState } from '../../domain/auth-state.js';
import type { AuthenticatedPrincipal } from '../query/index.js';
import { validateConfig, type Config } from './config.js';
import type { Clock, EpochStore, IDSource, SessionRevoker } from './ports.js';
import { event, nowMs, versionConflict } from './shared.js';

export type LogoutPorts = Readonly<{
  clock: Clock;
  ids: IDSource;
  store: SessionRevoker;
}>;
export type LogoutAllPorts = Readonly<{
  clock: Clock;
  ids: IDSource;
  store: EpochStore;
}>;
export type AuthenticatedInput = Readonly<{
  caller: AuthenticatedPrincipal;
  work: p.WorkContext;
}>;
export type LogoutResult = Readonly<{
  done: true;
  outcome: 'revoked' | 'already_inactive' | 'absent';
}>;
export type LogoutAllResult = Readonly<{ done: true; authEpoch: number }>;

/** Revokes the caller's own session; idempotent, event only for an actual change (U09). */
export class Logout {
  readonly #ports: LogoutPorts;
  private constructor(ports: LogoutPorts) {
    this.#ports = ports;
    Object.freeze(this);
  }
  static create(ports: LogoutPorts, config: Config): Result<Logout, Failure> {
    const c = validateConfig(config);
    return c.ok ? ok(new Logout(ports)) : c;
  }
  async execute(
    input: AuthenticatedInput,
  ): Promise<Result<LogoutResult, Failure>> {
    const { clock, ids, store } = this.#ports;
    const now = nowMs(clock);
    if (!now.ok) return now;
    const { principalId, sessionId } = input.caller;
    const revoked = event(
      ids,
      input.work,
      now.value,
      'identity.session.revoked.v1',
      {
        principal_id: principalId,
        session_id: sessionId,
        reason: 'logout',
      },
    );
    if (!revoked.ok) return revoked;
    const outcome = await store.revokeSession(
      sessionId,
      principalId,
      now.value,
      revoked.value,
    );
    if (!outcome.ok) return outcome;
    return ok({ done: true, outcome: outcome.value });
  }
}

/** Increments the auth epoch from the admitted one, invalidating every session (U10). */
export class LogoutAll {
  readonly #ports: LogoutAllPorts;
  private constructor(ports: LogoutAllPorts) {
    this.#ports = ports;
    Object.freeze(this);
  }
  static create(
    ports: LogoutAllPorts,
    config: Config,
  ): Result<LogoutAll, Failure> {
    const c = validateConfig(config);
    return c.ok ? ok(new LogoutAll(ports)) : c;
  }
  async execute(
    input: AuthenticatedInput,
  ): Promise<Result<LogoutAllResult, Failure>> {
    const { clock, ids, store } = this.#ports;
    const now = nowMs(clock);
    if (!now.ok) return now;
    const { principalId, authEpoch } = input.caller;
    const state = AuthState.create(principalId, authEpoch);
    if (!state.ok) return state;
    const next = state.value.invalidate(authEpoch);
    if (!next.ok) return next;
    const revoked = event(
      ids,
      input.work,
      now.value,
      'identity.sessions.revoked.v1',
      {
        principal_id: principalId,
        auth_epoch: next.value.epoch(),
        reason: 'logout_all',
      },
    );
    if (!revoked.ok) return revoked;
    const outcome = await store.revokeAll(
      principalId,
      authEpoch,
      now.value,
      revoked.value,
    );
    if (!outcome.ok) return outcome;
    if (outcome.value !== 'committed') return err(versionConflict());
    return ok({ done: true, authEpoch: next.value.epoch() });
  }
}
