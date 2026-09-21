import {
  err,
  ok,
  typedFailure,
  type TypedFailure,
  type Result,
} from '../../../shared/errors/index.js';
import type { ID } from '../../../shared/id/index.js';

export const SESSION_STATUSES = Object.freeze(['active', 'revoked'] as const);

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export type SessionInvalidFailureType =
  | 'session.invalid_time'
  | 'session.invalid_expiry'
  | 'session.invalid_state'
  | 'session.invalid_check_time'
  | 'session.invalid_revocation_time'
  | 'session.non_monotonic_time'
  | 'session.already_revoked';

export type SessionFailure =
  | TypedFailure<'invalid', SessionInvalidFailureType>
  | TypedFailure<'unauthenticated', 'session.revoked' | 'session.expired'>;

export type CreateSessionInput = Readonly<{
  id: ID;
  identityId: ID;
  createdAt: Date;
  expiresAt: Date;
}>;

export type RestoreSessionInput = Readonly<{
  id: ID;
  identityId: ID;
  status: SessionStatus;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}>;

type SessionState = Readonly<{
  id: ID;
  identityId: ID;
  status: SessionStatus;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}>;

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function copyDate(value: Date): Date {
  return new Date(value.getTime());
}

function invalid<const T extends SessionInvalidFailureType>(
  message: string,
  type: T,
): TypedFailure<'invalid', T> {
  return typedFailure('invalid', type, message);
}

export class Session {
  private constructor(private readonly state: SessionState) {
    Object.freeze(this.state);
  }

  static create(input: CreateSessionInput): Result<Session, SessionFailure> {
    if (!validDate(input.createdAt) || !validDate(input.expiresAt)) {
      return err(
        invalid('session times must be valid', 'session.invalid_time'),
      );
    }

    if (input.expiresAt.getTime() <= input.createdAt.getTime()) {
      return err(
        invalid('session must expire after creation', 'session.invalid_expiry'),
      );
    }

    const createdAt = copyDate(input.createdAt);

    return ok(
      new Session({
        id: input.id,
        identityId: input.identityId,
        status: 'active',
        createdAt,
        expiresAt: copyDate(input.expiresAt),
        revokedAt: null,
      }),
    );
  }

  static restore(input: RestoreSessionInput): Result<Session, SessionFailure> {
    if (
      !SESSION_STATUSES.includes(input.status) ||
      !validDate(input.createdAt) ||
      !validDate(input.expiresAt) ||
      (input.revokedAt !== null && !validDate(input.revokedAt))
    ) {
      return err(invalid('session state is invalid', 'session.invalid_state'));
    }

    if (input.expiresAt.getTime() <= input.createdAt.getTime()) {
      return err(
        invalid('session must expire after creation', 'session.invalid_expiry'),
      );
    }

    if (
      (input.status === 'active' && input.revokedAt !== null) ||
      (input.status === 'revoked' && input.revokedAt === null) ||
      (input.revokedAt !== null &&
        input.revokedAt.getTime() < input.createdAt.getTime())
    ) {
      return err(
        invalid('session revocation state is invalid', 'session.invalid_state'),
      );
    }

    return ok(
      new Session({
        id: input.id,
        identityId: input.identityId,
        status: input.status,
        createdAt: copyDate(input.createdAt),
        expiresAt: copyDate(input.expiresAt),
        revokedAt: input.revokedAt === null ? null : copyDate(input.revokedAt),
      }),
    );
  }

  get id(): ID {
    return this.state.id;
  }

  get identityId(): ID {
    return this.state.identityId;
  }

  get status(): SessionStatus {
    return this.state.status;
  }

  get createdAt(): Date {
    return copyDate(this.state.createdAt);
  }

  get expiresAt(): Date {
    return copyDate(this.state.expiresAt);
  }

  get revokedAt(): Date | null {
    return this.state.revokedAt === null
      ? null
      : copyDate(this.state.revokedAt);
  }

  assertUsable(at: Date): Result<void, SessionFailure> {
    if (!validDate(at)) {
      return err(
        invalid(
          'session check time must be valid',
          'session.invalid_check_time',
        ),
      );
    }

    if (this.status === 'revoked') {
      return err(
        typedFailure(
          'unauthenticated',
          'session.revoked',
          'session is revoked',
        ),
      );
    }

    if (at.getTime() >= this.state.expiresAt.getTime()) {
      return err(
        typedFailure(
          'unauthenticated',
          'session.expired',
          'session has expired',
        ),
      );
    }

    return ok(undefined);
  }

  revoke(at: Date): Result<Session, SessionFailure> {
    if (!validDate(at)) {
      return err(
        invalid(
          'session revocation time must be valid',
          'session.invalid_revocation_time',
        ),
      );
    }

    if (at.getTime() < this.state.createdAt.getTime()) {
      return err(
        invalid(
          'session revocation cannot precede creation',
          'session.non_monotonic_time',
        ),
      );
    }

    if (this.status === 'revoked') {
      return err(
        invalid('session is already revoked', 'session.already_revoked'),
      );
    }

    const revokedAt = copyDate(at);

    return ok(
      new Session({
        ...this.state,
        status: 'revoked',
        revokedAt,
      }),
    );
  }
}
