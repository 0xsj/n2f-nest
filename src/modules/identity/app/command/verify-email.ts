import {
  err,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type * as p from '../../../../shared/provenance/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import { Challenge } from '../../domain/challenge.js';
import { PasswordInput } from '../../domain/password.js';
import { validateConfig, type Config } from './config.js';
import type {
  AttemptLimiter,
  ChallengeReader,
  Clock,
  IDSource,
  PasswordHasherPort,
  TokenCodecPort,
  VerifyStore,
} from './ports.js';
import {
  admit,
  challengeRejected,
  digestSubject,
  event,
  nowMs,
} from './shared.js';

export type VerifyEmailPorts = Readonly<{
  clock: Clock;
  ids: IDSource;
  hasher: PasswordHasherPort;
  codec: TokenCodecPort;
  limiter: AttemptLimiter;
  store: ChallengeReader & VerifyStore;
}>;
export type VerifyEmailInput = Readonly<{
  token: SecretString;
  password: SecretString;
  source: string;
  work: p.WorkContext;
}>;
export type VerifyEmailResult = Readonly<{ verified: true; principalId: ID }>;

/** Consumes a verification challenge only with current password proof (U06, A10). */
export class VerifyEmail {
  readonly #ports: VerifyEmailPorts;
  private constructor(ports: VerifyEmailPorts) {
    this.#ports = ports;
    Object.freeze(this);
  }
  static create(
    ports: VerifyEmailPorts,
    config: Config,
  ): Result<VerifyEmail, Failure> {
    const c = validateConfig(config);
    return c.ok ? ok(new VerifyEmail(ports)) : c;
  }
  async execute(
    input: VerifyEmailInput,
  ): Promise<Result<VerifyEmailResult, Failure>> {
    const { clock, ids, hasher, codec, limiter, store } = this.#ports;
    const now = nowMs(clock);
    if (!now.ok) return now;
    const password = PasswordInput.parse(input.password);
    if (!password.ok) return password;
    const digest = codec.digest('email_verification', input.token);
    if (!digest.ok) return err(challengeRejected());
    const admission = await admit(
      limiter,
      'verify',
      new SecretString(digestSubject(digest.value)),
      input.source,
    );
    if (!admission.ok) return admission;
    const found = await store.findByDigest('email_verification', digest.value);
    if (!found.ok) return found;
    if (found.value === undefined) return err(challengeRejected());
    const { challenge, credential } = found.value;
    const matched = await hasher.verify(
      password.value,
      credential.passwordHash,
    );
    if (!matched.ok) return matched;
    if (!matched.value) return err(challengeRejected());
    const restored = Challenge.restore(challenge);
    if (!restored.ok) return restored;
    const consumed = restored.value.consume(
      'email_verification',
      credential.passwordVersion,
      now.value,
    );
    if (!consumed.ok)
      return consumed.error.kind === 'unauthenticated'
        ? err(challengeRejected())
        : consumed;
    const verified = event(
      ids,
      input.work,
      now.value,
      'identity.email.verified.v1',
      {
        principal_id: credential.principalId,
        challenge_id: challenge.id,
      },
    );
    if (!verified.ok) return verified;
    const outcome = await store.verifyEmail({
      challengeId: challenge.id,
      principalId: credential.principalId,
      consumedAtMs: now.value,
      expectedPasswordVersion: credential.passwordVersion,
      events: [verified.value],
    });
    if (!outcome.ok) return outcome;
    if (outcome.value !== 'committed') return err(challengeRejected());
    return ok({ verified: true, principalId: credential.principalId });
  }
}
