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
  /** Last authenticated use; never before creation. */
  lastSeenAt: Date;
  revokedAt: Date | null;
  version: Version;
}>;

type SessionState = Readonly<{
  id: ID;
  identityId: ID;
  status: SessionStatus;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  version: Version;
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
        lastSeenAt: copyDate(createdAt),
        revokedAt: null,
        version: UNSAVED,
      }),
    );
  }

  static restore(input: RestoreSessionInput): Result<Session, SessionFailure> {
    if (
      !SESSION_STATUSES.includes(input.status) ||
      !validDate(input.createdAt) ||
      !validDate(input.expiresAt) ||
      !validDate(input.lastSeenAt) ||
      input.lastSeenAt.getTime() < input.createdAt.getTime() ||
      (input.revokedAt !== null && !validDate(input.revokedAt)) ||
      !isStoredVersion(input.version)
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
        lastSeenAt: copyDate(input.lastSeenAt),
        revokedAt: input.revokedAt === null ? null : copyDate(input.revokedAt),
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

  get status(): SessionStatus {
    return this.state.status;
  }

  get createdAt(): Date {
    return copyDate(this.state.createdAt);
  }

  get expiresAt(): Date {
    return copyDate(this.state.expiresAt);
  }

  get lastSeenAt(): Date {
    return copyDate(this.state.lastSeenAt);
  }

  get revokedAt(): Date | null {
    return this.state.revokedAt === null
      ? null
      : copyDate(this.state.revokedAt);
  }

  /** The optimistic-concurrency token this state was loaded at. */
  get version(): Version {
    return this.state.version;
  }

  /** This state as storage holds it after a successful write. */
  saved(): Session {
    return new Session({ ...this.state, version: this.state.version + 1 });
  }

  /**
   * Whether the session can authenticate at `at`: active, before its absolute
   * expiry and, when `idleTimeoutMs` is given, used within that long. An idle
   * session reports `session.expired` like any other expiry.
   */
  assertUsable(at: Date, idleTimeoutMs?: number): Result<void, SessionFailure> {
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

    if (
      idleTimeoutMs !== undefined &&
      at.getTime() - this.state.lastSeenAt.getTime() >= idleTimeoutMs
    ) {
      return err(
        typedFailure(
          'unauthenticated',
          'session.expired',
          'session expired after inactivity',
        ),
      );
    }

    return ok(undefined);
  }

  /**
   * This session as last used at `at`. Activity only moves forward and does
   * not change the version: recording use never conflicts with a revocation.
   */
  seen(at: Date): Session {
    if (!validDate(at) || at.getTime() <= this.state.lastSeenAt.getTime()) {
      return this;
    }
    return new Session({ ...this.state, lastSeenAt: copyDate(at) });
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
