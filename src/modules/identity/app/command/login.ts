import {
  err,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type * as p from '../../../../shared/provenance/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import { Email } from '../../domain/email.js';
import { PasswordInput } from '../../domain/password.js';
import type { Kind } from '../../domain/principal.js';
import { Session } from '../../domain/session.js';
import { validateConfig, type Config } from './config.js';
import type {
  AttemptLimiter,
  Clock,
  CredentialReader,
  IDSource,
  LoginStore,
  PasswordHasherPort,
  TokenCodecPort,
} from './ports.js';
import { admit, credentialsRejected, event, newId, nowMs } from './shared.js';

export type LoginPorts = Readonly<{
  clock: Clock;
  ids: IDSource;
  hasher: PasswordHasherPort;
  codec: TokenCodecPort;
  limiter: AttemptLimiter;
  store: CredentialReader & LoginStore;
}>;
export type LoginInput = Readonly<{
  email: string;
  password: SecretString;
  source: string;
  work: p.WorkContext;
}>;
/** Safe projection for the transport; the token goes only to the cookie writer. */
export type LoginResult = Readonly<{
  sessionId: ID;
  token: SecretString;
  absoluteExpiresAtMs: number;
  idleExpiresAtMs: number;
  authEpoch: number;
  principal: Readonly<{ id: ID; kind: Kind; displayName: string }>;
}>;

/** One credential refusal for unknown, wrong, unverified, suspended and stale (U07). */
export class Login {
  readonly #ports: LoginPorts;
  readonly #config: Config;
  private constructor(ports: LoginPorts, config: Config) {
    this.#ports = ports;
    this.#config = config;
    Object.freeze(this);
  }
  static create(ports: LoginPorts, config: Config): Result<Login, Failure> {
    const c = validateConfig(config);
    return c.ok ? ok(new Login(ports, c.value)) : c;
  }
  async execute(input: LoginInput): Promise<Result<LoginResult, Failure>> {
    const { clock, ids, hasher, codec, limiter, store } = this.#ports;
    const now = nowMs(clock);
    if (!now.ok) return now;
    const email = Email.parse(input.email);
    if (!email.ok) return email;
    const password = PasswordInput.parse(input.password);
    if (!password.ok) return password;
    const admission = await admit(limiter, 'login', email.value, input.source);
    if (!admission.ok) return admission;
    const found = await store.findByEmail(email.value);
    if (!found.ok) return found;
    if (found.value === undefined) {
      const absent = await hasher.verifyAbsent(password.value);
      if (!absent.ok) return absent;
      return err(credentialsRejected());
    }
    const { principal, credential, authEpoch } = found.value;
    const matched = await hasher.verify(
      password.value,
      credential.passwordHash,
    );
    if (!matched.ok) return matched;
    if (
      !matched.value ||
      principal.status !== 'active' ||
      credential.verifiedAtMs === undefined
    )
      return err(credentialsRejected());
    const sessionId = newId(ids);
    if (!sessionId.ok) return sessionId;
    const token = codec.issue('session');
    if (!token.ok) return token;
    const absoluteExpiresAtMs = now.value + this.#config.sessionAbsoluteMs;
    const idleExpiresAtMs = now.value + this.#config.sessionIdleMs;
    const session = Session.issue(
      sessionId.value,
      principal.id,
      token.value.digest,
      authEpoch,
      now.value,
      absoluteExpiresAtMs,
      idleExpiresAtMs,
    );
    if (!session.ok) return session;
    const created = event(
      ids,
      input.work,
      now.value,
      'identity.session.created.v1',
      {
        principal_id: principal.id,
        session_id: sessionId.value,
        auth_epoch: authEpoch,
      },
    );
    if (!created.ok) return created;
    const outcome = await store.commitLogin({
      session: session.value.snapshot(),
      expectedPasswordVersion: credential.passwordVersion,
      expectedAuthEpoch: authEpoch,
      events: [created.value],
    });
    if (!outcome.ok) return outcome;
    if (outcome.value !== 'committed') return err(credentialsRejected());
    return ok({
      sessionId: sessionId.value,
      token: token.value.secret,
      absoluteExpiresAtMs,
      idleExpiresAtMs,
      authEpoch,
      principal: {
        id: principal.id,
        kind: principal.kind,
        displayName: principal.displayName,
      },
    });
  }
}
