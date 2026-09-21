import {
  err,
  ok,
  typedFailure,
  type TypedFailure,
  type Result,
} from '../../../shared/errors/index.js';
import type { ID } from '../../../shared/id/index.js';

export const IDENTITY_STATUSES = Object.freeze([
  'pending_verification',
  'active',
  'suspended',
  'disabled',
] as const);

export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];

export type IdentityFailureType =
  | 'identity.invalid_created_at'
  | 'identity.invalid_state'
  | 'identity.non_monotonic_time'
  | 'identity.invalid_verification'
  | 'identity.invalid_suspension'
  | 'identity.already_disabled'
  | 'identity.invalid_reactivation'
  | 'identity.invalid_transition_time';

export type IdentityFailure = TypedFailure<'invalid', IdentityFailureType>;

export type RegisterIdentityInput = Readonly<{
  id: ID;
  createdAt: Date;
}>;

export type RestoreIdentityInput = Readonly<{
  id: ID;
  status: IdentityStatus;
  createdAt: Date;
  updatedAt: Date;
  verifiedAt: Date | null;
}>;

type IdentityState = Readonly<{
  id: ID;
  status: IdentityStatus;
  createdAt: Date;
  updatedAt: Date;
  verifiedAt: Date | null;
}>;

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function copyDate(value: Date): Date {
  return new Date(value.getTime());
}

function invalid<const T extends IdentityFailureType>(
  message: string,
  type: T,
): TypedFailure<'invalid', T> {
  return typedFailure('invalid', type, message);
}

export class Identity {
  private constructor(private readonly state: IdentityState) {
    Object.freeze(this.state);
  }

  static register(
    input: RegisterIdentityInput,
  ): Result<Identity, IdentityFailure> {
    if (!validDate(input.createdAt)) {
      return err(
        invalid(
          'identity creation time must be valid',
          'identity.invalid_created_at',
        ),
      );
    }

    const createdAt = copyDate(input.createdAt);

    return ok(
      new Identity({
        id: input.id,
        status: 'pending_verification',
        createdAt,
        updatedAt: copyDate(createdAt),
        verifiedAt: null,
      }),
    );
  }

  static restore(
    input: RestoreIdentityInput,
  ): Result<Identity, IdentityFailure> {
    if (
      !IDENTITY_STATUSES.includes(input.status) ||
      !validDate(input.createdAt) ||
      !validDate(input.updatedAt) ||
      (input.verifiedAt !== null && !validDate(input.verifiedAt))
    ) {
      return err(
        invalid('identity state is invalid', 'identity.invalid_state'),
      );
    }

    if (input.updatedAt.getTime() < input.createdAt.getTime()) {
      return err(
        invalid(
          'identity update time cannot precede creation',
          'identity.non_monotonic_time',
        ),
      );
    }

    if (
      (input.status === 'pending_verification' && input.verifiedAt !== null) ||
      (input.status !== 'pending_verification' &&
        input.status !== 'disabled' &&
        input.verifiedAt === null)
    ) {
      return err(
        invalid(
          'identity verification state is invalid',
          'identity.invalid_state',
        ),
      );
    }

    return ok(
      new Identity({
        id: input.id,
        status: input.status,
        createdAt: copyDate(input.createdAt),
        updatedAt: copyDate(input.updatedAt),
        verifiedAt:
          input.verifiedAt === null ? null : copyDate(input.verifiedAt),
      }),
    );
  }

  get id(): ID {
    return this.state.id;
  }

  get status(): IdentityStatus {
    return this.state.status;
  }

  get createdAt(): Date {
    return copyDate(this.state.createdAt);
  }

  get updatedAt(): Date {
    return copyDate(this.state.updatedAt);
  }

  get verifiedAt(): Date | null {
    return this.state.verifiedAt === null
      ? null
      : copyDate(this.state.verifiedAt);
  }

  verify(at: Date): Result<Identity, IdentityFailure> {
    const time = this.transitionTime(at);

    if (!time.ok) {
      return time;
    }

    if (this.status !== 'pending_verification') {
      return err(
        invalid(
          'only pending identities can be verified',
          'identity.invalid_verification',
        ),
      );
    }

    return ok(
      this.evolve({
        status: 'active',
        updatedAt: time.value,
        verifiedAt: time.value,
      }),
    );
  }

  suspend(at: Date): Result<Identity, IdentityFailure> {
    const time = this.transitionTime(at);

    if (!time.ok) {
      return time;
    }

    if (this.status !== 'active') {
      return err(
        invalid(
          'only active identities can be suspended',
          'identity.invalid_suspension',
        ),
      );
    }

    return ok(
      this.evolve({
        status: 'suspended',
        updatedAt: time.value,
      }),
    );
  }

  disable(at: Date): Result<Identity, IdentityFailure> {
    const time = this.transitionTime(at);

    if (!time.ok) {
      return time;
    }

    if (this.status === 'disabled') {
      return err(
        invalid('identity is already disabled', 'identity.already_disabled'),
      );
    }

    return ok(
      this.evolve({
        status: 'disabled',
        updatedAt: time.value,
      }),
    );
  }

  reactivate(at: Date): Result<Identity, IdentityFailure> {
    const time = this.transitionTime(at);

    if (!time.ok) {
      return time;
    }

    if (this.status !== 'suspended') {
      return err(
        invalid(
          'only suspended identities can be reactivated',
          'identity.invalid_reactivation',
        ),
      );
    }

    return ok(
      this.evolve({
        status: 'active',
        updatedAt: time.value,
      }),
    );
  }

  private transitionTime(at: Date): Result<Date, IdentityFailure> {
    if (!validDate(at)) {
      return err(
        invalid(
          'identity transition time must be valid',
          'identity.invalid_transition_time',
        ),
      );
    }

    if (at.getTime() < this.state.updatedAt.getTime()) {
      return err(
        invalid(
          'identity transition time cannot move backwards',
          'identity.non_monotonic_time',
        ),
      );
    }

    return ok(copyDate(at));
  }

  private evolve(patch: Partial<IdentityState>): Identity {
    const verifiedAt =
      patch.verifiedAt === undefined ? this.state.verifiedAt : patch.verifiedAt;

    return new Identity({
      id: this.state.id,
      status: patch.status ?? this.state.status,
      createdAt: copyDate(patch.createdAt ?? this.state.createdAt),
      updatedAt: copyDate(patch.updatedAt ?? this.state.updatedAt),
      verifiedAt: verifiedAt === null ? null : copyDate(verifiedAt),
    });
  }
}
