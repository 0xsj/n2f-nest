import {
  err,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type * as p from '../../../../shared/provenance/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import { AuthState } from '../../domain/auth-state.js';
import { Challenge } from '../../domain/challenge.js';
import { PasswordCredential } from '../../domain/credential.js';
import { Email } from '../../domain/email.js';
import { NewPassword } from '../../domain/password.js';
import { Principal } from '../../domain/principal.js';
import { validateConfig, type Config } from './config.js';
import type {
  AttemptLimiter,
  Clock,
  EnrollmentPolicy,
  IDSource,
  MailDelivery,
  PasswordHasherPort,
  RegisterStore,
  TokenCodecPort,
} from './ports.js';
import {
  admit,
  deliver,
  event,
  newId,
  nowMs,
  passwordNotAllowed,
} from './shared.js';

export type RegisterPorts = Readonly<{
  clock: Clock;
  ids: IDSource;
  hasher: PasswordHasherPort;
  codec: TokenCodecPort;
  policy: EnrollmentPolicy;
  limiter: AttemptLimiter;
  mail: MailDelivery;
  store: RegisterStore;
}>;
export type RegisterInput = Readonly<{
  email: string;
  password: SecretString;
  source: string;
  work: p.WorkContext;
}>;
/** Private result; transport projects both outcomes to the same accepted response (U04). */
export type RegisterResult = Readonly<{
  accepted: true;
  outcome: 'created' | 'duplicate_email';
  mailDelivered: boolean;
}>;

/** Derive the interim display name from the local part until a profile exists. */
export function displayNameFrom(email: Email): string {
  const local = email.reveal().split('@')[0] ?? '';
  return Array.from(local).slice(0, 100).join('');
}

export class Register {
  readonly #ports: RegisterPorts;
  readonly #config: Config;
  private constructor(ports: RegisterPorts, config: Config) {
    this.#ports = ports;
    this.#config = config;
    Object.freeze(this);
  }
  static create(
    ports: RegisterPorts,
    config: Config,
  ): Result<Register, Failure> {
    const c = validateConfig(config);
    return c.ok ? ok(new Register(ports, c.value)) : c;
  }
  async execute(
    input: RegisterInput,
  ): Promise<Result<RegisterResult, Failure>> {
    const { clock, ids, hasher, codec, policy, limiter, mail, store } =
      this.#ports;
    const now = nowMs(clock);
    if (!now.ok) return now;
    const email = Email.parse(input.email);
    if (!email.ok) return email;
    const admission = await admit(
      limiter,
      'register',
      email.value,
      input.source,
    );
    if (!admission.ok) return admission;
    const password = NewPassword.parse(input.password);
    if (!password.ok) return password;
    const allowed = await policy.checkBlocklist(password.value);
    if (!allowed.ok) return allowed;
    if (!allowed.value) return err(passwordNotAllowed());
    const hash = await hasher.hash(password.value);
    if (!hash.ok) return hash;
    const principalId = newId(ids);
    if (!principalId.ok) return principalId;
    const challengeId = newId(ids);
    if (!challengeId.ok) return challengeId;
    const principal = Principal.register(
      principalId.value,
      'human',
      displayNameFrom(email.value),
      now.value,
    );
    if (!principal.ok) return principal;
    const epoch = AuthState.create(principalId.value, 1);
    if (!epoch.ok) return epoch;
    const credential = PasswordCredential.restore({
      principalId: principalId.value,
      email: email.value,
      passwordHash: hash.value,
      passwordVersion: 1,
      createdAtMs: now.value,
      changedAtMs: now.value,
    });
    if (!credential.ok) return credential;
    const token = codec.issue('email_verification');
    if (!token.ok) return token;
    const challenge = Challenge.issue(
      challengeId.value,
      principalId.value,
      token.value.digest,
      1,
      now.value,
      now.value + this.#config.verificationTtlMs,
    );
    if (!challenge.ok) return challenge;
    const registered = event(
      ids,
      input.work,
      now.value,
      'identity.principal.registered.v1',
      {
        principal_id: principalId.value,
        kind: 'human',
        origin: 'self_registration',
      },
    );
    if (!registered.ok) return registered;
    const outcome = await store.register({
      principal: principal.value.snapshot(),
      authEpoch: epoch.value.epoch(),
      credential: credential.value.snapshot(),
      challenge: challenge.value.snapshot(),
      events: [registered.value],
    });
    if (!outcome.ok) return outcome;
    if (outcome.value !== 'created')
      return ok({
        accepted: true,
        outcome: outcome.value,
        mailDelivered: false,
      });
    const mailDelivered = await deliver(() =>
      mail.sendVerification(
        email.value,
        token.value.secret,
        challenge.value.snapshot().expiresAtMs,
      ),
    );
    return ok({ accepted: true, outcome: 'created', mailDelivered });
  }
}
