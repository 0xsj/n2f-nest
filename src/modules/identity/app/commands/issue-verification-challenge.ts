import {
  err,
  ok,
  typedFailure,
  type Result,
} from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import type { WallClock } from '../../../../shared/clock/index.js';
import type { IDGenerator } from '../../../../shared/id/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import { IDENTITY_EVENT_TYPES } from '../../domain/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import {
  Identity,
  VerificationChallenge,
  type IdentityStatus,
} from '../../domain/index.js';
import type {
  IdentityReader,
  VerificationChallengeWriter,
  VerificationPolicy,
  VerificationTokenIssuer,
} from '../ports/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type IdentityApplicationFailure,
} from '../failures.js';

export type IssueVerificationChallengeCommand = Readonly<{
  identityId: Identity['id'];
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type IssueVerificationChallengeResult = Readonly<{
  identityId: Identity['id'];
  challengeId: VerificationChallenge['id'];
  token: SecretString;
  expiresAt: Date;
}>;

export type IssueVerificationChallengeDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  identities: IdentityReader;
  policy: VerificationPolicy;
  tokens: VerificationTokenIssuer;
  writer: VerificationChallengeWriter;
}>;

function notFound(): IdentityApplicationFailure {
  return typedFailure(
    'not_found',
    'identity.not_found',
    'identity was not found',
  );
}

function unavailableStatus(status: IdentityStatus): IdentityApplicationFailure {
  return typedFailure(
    'conflict',
    'identity.verification_unavailable',
    `identity is ${status}`,
  );
}

export class IssueVerificationChallenge {
  constructor(
    private readonly dependencies: IssueVerificationChallengeDependencies,
  ) {}

  async execute(
    command: IssueVerificationChallengeCommand,
  ): Promise<
    Result<IssueVerificationChallengeResult, IdentityApplicationFailure>
  > {
    const identity = await this.dependencies.identities.find(
      command.identityId,
      command.signal,
    );

    if (!identity.ok) {
      return err(dependencyFailure(identity.error, 'identity_reader'));
    }
    if (identity.value === null) return err(notFound());
    if (identity.value.status !== 'pending_verification') {
      return err(unavailableStatus(identity.value.status));
    }

    const issuedAt = this.dependencies.clock.now();
    const expiresAt = this.dependencies.policy.expiresAt(issuedAt);
    if (!expiresAt.ok) {
      return err(dependencyFailure(expiresAt.error, 'verification_policy'));
    }

    const challengeId = this.dependencies.ids.newId();
    if (!challengeId.ok) return err(idGenerationFailure(challengeId.error));

    const challenge = VerificationChallenge.issue({
      id: challengeId.value,
      identityId: identity.value.id,
      purpose: 'email_verification',
      issuedAt,
      expiresAt: expiresAt.value,
    });
    if (!challenge.ok) return challenge;

    const token = await this.dependencies.tokens.issue(command.signal);
    if (!token.ok) {
      return err(dependencyFailure(token.error, 'verification_token_issuer'));
    }

    const eventId = this.dependencies.ids.newId();
    if (!eventId.ok) return err(idGenerationFailure(eventId.error));

    const event = Envelope.create(
      eventId.value,
      IDENTITY_EVENT_TYPES.verificationChallengeIssued,
      issuedAt.getTime(),
      command.work,
      {
        identity_id: challenge.value.identityId,
        challenge_id: challenge.value.id,
        purpose: challenge.value.purpose,
        expires_at_ms: challenge.value.expiresAt.getTime(),
      },
      { kind: 'identity', id: challenge.value.identityId },
    );
    if (!event.ok) {
      return err(
        dependencyFailure(event.error, 'verification_challenge_event'),
      );
    }

    const committed = await this.dependencies.writer.commit(
      {
        challenge: challenge.value,
        tokenDigest: token.value.digest,
        event: event.value,
        work: command.work,
      },
      command.signal,
    );
    if (!committed.ok) {
      return err(
        dependencyFailure(committed.error, 'verification_challenge_writer'),
      );
    }

    return ok({
      identityId: challenge.value.identityId,
      challengeId: challenge.value.id,
      token: token.value.token,
      expiresAt: challenge.value.expiresAt,
    });
  }
}
