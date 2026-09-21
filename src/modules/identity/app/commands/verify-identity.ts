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
import type {
  Identity,
  IdentityStatus,
  VerificationChallenge,
} from '../../domain/index.js';
import type {
  IdentityReader,
  VerificationChallengeReader,
  VerificationTokenVerifier,
  VerificationWriter,
} from '../ports/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type IdentityApplicationFailure,
} from '../failures.js';

export type VerifyIdentityCommand = Readonly<{
  challengeId: VerificationChallenge['id'];
  token: SecretString;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type VerifyIdentityResult = Readonly<{
  identityId: Identity['id'];
  status: IdentityStatus;
}>;

export type VerifyIdentityDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  identities: IdentityReader;
  challenges: VerificationChallengeReader;
  tokens: VerificationTokenVerifier;
  writer: VerificationWriter;
}>;

function notFound(): IdentityApplicationFailure {
  return typedFailure(
    'not_found',
    'identity.verification_not_found',
    'verification challenge was not found',
  );
}

function invalidToken(): IdentityApplicationFailure {
  return typedFailure(
    'unauthenticated',
    'identity.invalid_verification_token',
    'verification token is invalid',
  );
}

export class VerifyIdentity {
  constructor(private readonly dependencies: VerifyIdentityDependencies) {}

  async execute(
    command: VerifyIdentityCommand,
  ): Promise<Result<VerifyIdentityResult, IdentityApplicationFailure>> {
    const record = await this.dependencies.challenges.find(
      command.challengeId,
      command.signal,
    );

    if (!record.ok) {
      return err(
        dependencyFailure(record.error, 'verification_challenge_reader'),
      );
    }

    if (record.value === null) {
      return err(notFound());
    }

    const token = await this.dependencies.tokens.verify(
      command.token,
      record.value.tokenDigest,
      command.signal,
    );

    if (!token.ok) {
      return err(dependencyFailure(token.error, 'verification_token_verifier'));
    }

    if (!token.value) {
      return err(invalidToken());
    }

    const identity = await this.dependencies.identities.find(
      record.value.challenge.identityId,
      command.signal,
    );

    if (!identity.ok) {
      return err(dependencyFailure(identity.error, 'identity_reader'));
    }

    if (identity.value === null) {
      return err(
        typedFailure(
          'not_found',
          'identity.not_found',
          'identity was not found',
        ),
      );
    }

    const at = this.dependencies.clock.now();
    const consumed = record.value.challenge.consume(at);

    if (!consumed.ok) {
      return consumed;
    }

    const verified = identity.value.verify(at);

    if (!verified.ok) {
      return verified;
    }

    const eventId = this.dependencies.ids.newId();

    if (!eventId.ok) {
      return err(idGenerationFailure(eventId.error));
    }

    const event = Envelope.create(
      eventId.value,
      IDENTITY_EVENT_TYPES.verified,
      at.getTime(),
      command.work,
      {
        identity_id: verified.value.id,
        challenge_id: consumed.value.id,
        purpose: consumed.value.purpose,
        status: verified.value.status,
      },
    );

    if (!event.ok) {
      return err(dependencyFailure(event.error, 'identity_verified_event'));
    }

    const committed = await this.dependencies.writer.commit(
      {
        identity: verified.value,
        challenge: consumed.value,
        event: event.value,
        work: command.work,
      },
      command.signal,
    );

    if (!committed.ok) {
      return err(dependencyFailure(committed.error, 'verification_writer'));
    }

    return ok({
      identityId: verified.value.id,
      status: verified.value.status,
    });
  }
}
