import {
  err,
  ok,
  typedFailure,
  type TypedFailure,
  type Result,
} from '../../../shared/errors/index.js';
import type { ID } from '../../../shared/id/index.js';
import {
  UNSAVED,
  isStoredVersion,
  type Version,
} from '../../../shared/version/index.js';

export const VERIFICATION_PURPOSES = Object.freeze([
  'email_verification',
  'password_reset',
] as const);

export type VerificationPurpose = (typeof VERIFICATION_PURPOSES)[number];

export const VERIFICATION_STATUSES = Object.freeze([
  'issued',
  'consumed',
] as const);

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export type VerificationFailureType =
  | 'verification.invalid_time'
  | 'verification.invalid_expiry'
  | 'verification.invalid_state'
  | 'verification.invalid_consumption_time'
  | 'verification.non_monotonic_time'
  | 'verification.already_consumed'
  | 'verification.expired';

export type VerificationFailure = TypedFailure<
  'invalid',
  VerificationFailureType
>;

export type IssueVerificationChallengeInput = Readonly<{
  id: ID;
  identityId: ID;
  purpose: VerificationPurpose;
  issuedAt: Date;
  expiresAt: Date;
}>;

export type RestoreVerificationChallengeInput = Readonly<{
  id: ID;
  identityId: ID;
  purpose: VerificationPurpose;
  status: VerificationStatus;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  version: Version;
}>;

type VerificationChallengeState = Readonly<{
  id: ID;
  identityId: ID;
  purpose: VerificationPurpose;
  status: VerificationStatus;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  version: Version;
}>;

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function copyDate(value: Date): Date {
  return new Date(value.getTime());
}

function invalid<const T extends VerificationFailureType>(
  message: string,
  type: T,
): TypedFailure<'invalid', T> {
  return typedFailure('invalid', type, message);
}

export class VerificationChallenge {
  private constructor(private readonly state: VerificationChallengeState) {
    Object.freeze(this.state);
  }

  static issue(
    input: IssueVerificationChallengeInput,
  ): Result<VerificationChallenge, VerificationFailure> {
    if (!validDate(input.issuedAt) || !validDate(input.expiresAt)) {
      return err(
        invalid(
          'verification challenge times must be valid',
          'verification.invalid_time',
        ),
      );
    }

    if (input.expiresAt.getTime() <= input.issuedAt.getTime()) {
      return err(
        invalid(
          'verification challenge must expire after issuance',
          'verification.invalid_expiry',
        ),
      );
    }

    const issuedAt = copyDate(input.issuedAt);
    const expiresAt = copyDate(input.expiresAt);

    return ok(
      new VerificationChallenge({
        id: input.id,
        identityId: input.identityId,
        purpose: input.purpose,
        status: 'issued',
        issuedAt,
        expiresAt,
        consumedAt: null,
        version: UNSAVED,
      }),
    );
  }

  static restore(
    input: RestoreVerificationChallengeInput,
  ): Result<VerificationChallenge, VerificationFailure> {
    if (
      !VERIFICATION_PURPOSES.includes(input.purpose) ||
      !VERIFICATION_STATUSES.includes(input.status) ||
      !validDate(input.issuedAt) ||
      !validDate(input.expiresAt) ||
      (input.consumedAt !== null && !validDate(input.consumedAt)) ||
      !isStoredVersion(input.version)
    ) {
      return err(
        invalid(
          'verification challenge state is invalid',
          'verification.invalid_state',
        ),
      );
    }

    if (input.expiresAt.getTime() <= input.issuedAt.getTime()) {
      return err(
        invalid(
          'verification challenge must expire after issuance',
          'verification.invalid_expiry',
        ),
      );
    }

    if (
      (input.status === 'issued' && input.consumedAt !== null) ||
      (input.status === 'consumed' && input.consumedAt === null) ||
      (input.consumedAt !== null &&
        (input.consumedAt.getTime() < input.issuedAt.getTime() ||
          input.consumedAt.getTime() >= input.expiresAt.getTime()))
    ) {
      return err(
        invalid(
          'verification challenge consumption state is invalid',
          'verification.invalid_state',
        ),
      );
    }

    return ok(
      new VerificationChallenge({
        id: input.id,
        identityId: input.identityId,
        purpose: input.purpose,
        status: input.status,
        issuedAt: copyDate(input.issuedAt),
        expiresAt: copyDate(input.expiresAt),
        consumedAt:
          input.consumedAt === null ? null : copyDate(input.consumedAt),
        version: input.version,
      }),
    );
  }

  get id(): ID {
    return this.state.id;
  }

  get identityId(): ID {
    return this.state.identityId;
  }

  get purpose(): VerificationPurpose {
    return this.state.purpose;
  }

  get status(): VerificationStatus {
    return this.state.status;
  }

  get issuedAt(): Date {
    return copyDate(this.state.issuedAt);
  }

  get expiresAt(): Date {
    return copyDate(this.state.expiresAt);
  }

  get consumedAt(): Date | null {
    return this.state.consumedAt === null
      ? null
      : copyDate(this.state.consumedAt);
  }

  /** The optimistic-concurrency token this state was loaded at. */
  get version(): Version {
    return this.state.version;
  }

  /** This state as storage holds it after a successful write. */
  saved(): VerificationChallenge {
    return new VerificationChallenge({ ...this.state, version: this.state.version + 1 });
  }

  consume(at: Date): Result<VerificationChallenge, VerificationFailure> {
    if (!validDate(at)) {
      return err(
        invalid(
          'verification consumption time must be valid',
          'verification.invalid_consumption_time',
        ),
      );
    }

    if (at.getTime() < this.state.issuedAt.getTime()) {
      return err(
        invalid(
          'verification consumption cannot precede issuance',
          'verification.non_monotonic_time',
        ),
      );
    }

    if (this.status === 'consumed') {
      return err(
        invalid(
          'verification challenge is already consumed',
          'verification.already_consumed',
        ),
      );
    }

    if (at.getTime() >= this.state.expiresAt.getTime()) {
      return err(
        invalid('verification challenge has expired', 'verification.expired'),
      );
    }

    const consumedAt = copyDate(at);

    return ok(
      new VerificationChallenge({
        ...this.state,
        status: 'consumed',
        consumedAt,
      }),
    );
  }
}
