import type { Envelope } from '../../../../shared/events/index.js';
import type { Publisher } from '../../../../shared/events/index.js';
import { ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type {
  Credential,
  Identity,
  Session,
  VerificationChallenge,
} from '../../domain/index.js';

export type StoredSession = Readonly<{
  session: Session;
  tokenDigest: SecretString;
}>;

export type StoredVerificationChallenge = Readonly<{
  challenge: VerificationChallenge;
  tokenDigest: SecretString;
}>;

/** Process-local state for the integration harness; it is deliberately not durable. */
export class InMemoryIdentityStore {
  constructor(readonly publisher?: Publisher) {}

  readonly identities = new Map<string, Identity>();
  readonly credentials = new Map<string, Credential>();
  readonly passwordHashes = new Map<string, SecretString>();
  readonly challenges = new Map<string, StoredVerificationChallenge>();
  readonly sessions = new Map<string, StoredSession>();
  readonly events: Envelope[] = [];

  dispatch(event: Envelope): Promise<Result<void, Failure>> {
    if (!this.publisher) return Promise.resolve(ok(undefined));
    return this.publisher.publish(event).then((result) =>
      result.ok ? ok(undefined) : result,
    );
  }
}
