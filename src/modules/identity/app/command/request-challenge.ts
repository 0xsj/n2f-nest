import {
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type * as p from '../../../../shared/provenance/index.js';
import { Challenge } from '../../domain/challenge.js';
import { Email } from '../../domain/email.js';
import { validateConfig, type Config } from './config.js';
import type {
  AttemptLimiter,
  ChallengeStore,
  Clock,
  CredentialReader,
  IDSource,
  MailDelivery,
  TokenCodecPort,
} from './ports.js';
import { admit, deliver, newId, nowMs } from './shared.js';

export type RequestChallengePorts = Readonly<{
  clock: Clock;
  ids: IDSource;
  codec: TokenCodecPort;
  limiter: AttemptLimiter;
  mail: MailDelivery;
  store: CredentialReader & ChallengeStore;
}>;
export type RequestChallengeInput = Readonly<{
  email: string;
  source: string;
  work: p.WorkContext;
}>;
/** Private result; every outcome is the same public accepted response (U05, U12). */
export type RequestChallengeResult = Readonly<{
  accepted: true;
  outcome: 'issued' | 'absent' | 'inactive' | 'already_verified' | 'stale';
  mailDelivered: boolean;
}>;
type Kind = 'verification' | 'reset';

class RequestChallenge {
  readonly #ports: RequestChallengePorts;
  readonly #config: Config;
  readonly #kind: Kind;
  protected constructor(
    ports: RequestChallengePorts,
    config: Config,
    kind: Kind,
  ) {
    this.#ports = ports;
    this.#config = config;
    this.#kind = kind;
    Object.freeze(this);
  }
  async execute(
    input: RequestChallengeInput,
  ): Promise<Result<RequestChallengeResult, Failure>> {
    const { clock, ids, codec, limiter, mail, store } = this.#ports;
    const reset = this.#kind === 'reset';
    const now = nowMs(clock);
    if (!now.ok) return now;
    const email = Email.parse(input.email);
    if (!email.ok) return email;
    const admission = await admit(
      limiter,
      reset ? 'reset_request' : 'verification_request',
      email.value,
      input.source,
    );
    if (!admission.ok) return admission;
    const found = await store.findByEmail(email.value);
    if (!found.ok) return found;
    if (found.value === undefined)
      return ok({ accepted: true, outcome: 'absent', mailDelivered: false });
    // A principal that is not active gets no challenge and no mail; the public
    // response is unchanged so suspension is not disclosed (U05, U12, U17).
    if (found.value.principal.status !== 'active')
      return ok({ accepted: true, outcome: 'inactive', mailDelivered: false });
    const { credential } = found.value;
    if (!reset && credential.verifiedAtMs !== undefined)
      return ok({
        accepted: true,
        outcome: 'already_verified',
        mailDelivered: false,
      });
    const id = newId(ids);
    if (!id.ok) return id;
    const token = codec.issue(reset ? 'password_reset' : 'email_verification');
    if (!token.ok) return token;
    const expiresAtMs =
      now.value +
      (reset ? this.#config.resetTtlMs : this.#config.verificationTtlMs);
    const challenge = Challenge.issue(
      id.value,
      credential.principalId,
      token.value.digest,
      credential.passwordVersion,
      now.value,
      expiresAtMs,
    );
    if (!challenge.ok) return challenge;
    const issued = await store.issueChallenge({
      challenge: challenge.value.snapshot(),
      expectedPasswordVersion: credential.passwordVersion,
    });
    if (!issued.ok) return issued;
    if (issued.value !== 'issued')
      return ok({ accepted: true, outcome: 'stale', mailDelivered: false });
    const mailDelivered = await deliver(() =>
      reset
        ? mail.sendReset(email.value, token.value.secret, expiresAtMs)
        : mail.sendVerification(email.value, token.value.secret, expiresAtMs),
    );
    return ok({ accepted: true, outcome: 'issued', mailDelivered });
  }
}
export class RequestVerification extends RequestChallenge {
  static create(
    ports: RequestChallengePorts,
    config: Config,
  ): Result<RequestVerification, Failure> {
    const c = validateConfig(config);
    return c.ok
      ? ok(new RequestVerification(ports, c.value, 'verification'))
      : c;
  }
}
export class RequestReset extends RequestChallenge {
  static create(
    ports: RequestChallengePorts,
    config: Config,
  ): Result<RequestReset, Failure> {
    const c = validateConfig(config);
    return c.ok ? ok(new RequestReset(ports, c.value, 'reset')) : c;
  }
}
