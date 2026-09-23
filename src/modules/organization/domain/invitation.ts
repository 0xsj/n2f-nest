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

export const INVITATION_ROLES = Object.freeze(['admin', 'member'] as const);
export type InvitationRole = (typeof INVITATION_ROLES)[number];

export const INVITATION_STATUSES = Object.freeze([
  'pending',
  'accepted',
  'revoked',
] as const);
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export type InvitationFailureType =
  | 'invitation.invalid_role'
  | 'invitation.invalid_time'
  | 'invitation.invalid_expiry'
  | 'invitation.invalid_state'
  | 'invitation.not_pending'
  | 'invitation.expired'
  | 'invitation.non_monotonic_time';

export type InvitationFailure = TypedFailure<'invalid', InvitationFailureType>;

export type IssueInvitationInput = Readonly<{
  id: ID;
  organizationId: ID;
  identityId: ID;
  role: unknown;
  createdAt: Date;
  expiresAt: Date;
}>;

export type RestoreInvitationInput = Readonly<{
  id: ID;
  organizationId: ID;
  identityId: ID;
  role: InvitationRole;
  status: InvitationStatus;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  version: Version;
}>;

type InvitationState = Readonly<{
  id: ID;
  organizationId: ID;
  identityId: ID;
  role: InvitationRole;
  status: InvitationStatus;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  version: Version;
}>;

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function copyDate(value: Date): Date {
  return new Date(value.getTime());
}

function invalid(
  message: string,
  type: InvitationFailureType,
): InvitationFailure {
  return typedFailure('invalid', type, message);
}

export class Invitation {
  private constructor(private readonly state: InvitationState) {
    Object.freeze(this.state);
  }

  static issue(
    input: IssueInvitationInput,
  ): Result<Invitation, InvitationFailure> {
    if (!INVITATION_ROLES.includes(input.role as InvitationRole)) {
      return err(
        invalid('invitation role is invalid', 'invitation.invalid_role'),
      );
    }
    if (!validDate(input.createdAt) || !validDate(input.expiresAt)) {
      return err(
        invalid('invitation time is invalid', 'invitation.invalid_time'),
      );
    }
    if (input.expiresAt.getTime() <= input.createdAt.getTime()) {
      return err(
        invalid(
          'invitation expiry must be after creation',
          'invitation.invalid_expiry',
        ),
      );
    }

    const createdAt = copyDate(input.createdAt);
    return ok(
      new Invitation({
        id: input.id,
        organizationId: input.organizationId,
        identityId: input.identityId,
        role: input.role as InvitationRole,
        status: 'pending',
        createdAt,
        updatedAt: copyDate(createdAt),
        expiresAt: copyDate(input.expiresAt),
        acceptedAt: null,
        revokedAt: null,
        version: UNSAVED,
      }),
    );
  }

  static restore(
    input: RestoreInvitationInput,
  ): Result<Invitation, InvitationFailure> {
    if (
      !INVITATION_ROLES.includes(input.role) ||
      !INVITATION_STATUSES.includes(input.status) ||
      !validDate(input.createdAt) ||
      !validDate(input.updatedAt) ||
      !validDate(input.expiresAt) ||
      (input.acceptedAt !== null && !validDate(input.acceptedAt)) ||
      (input.revokedAt !== null && !validDate(input.revokedAt)) ||
      !isStoredVersion(input.version)
    ) {
      return err(
        invalid('invitation state is invalid', 'invitation.invalid_state'),
      );
    }
    if (
      input.updatedAt.getTime() < input.createdAt.getTime() ||
      input.expiresAt.getTime() <= input.createdAt.getTime()
    ) {
      return err(
        invalid('invitation time is invalid', 'invitation.invalid_time'),
      );
    }
    if (
      (input.status === 'pending' &&
        (input.acceptedAt !== null || input.revokedAt !== null)) ||
      (input.status === 'accepted' &&
        (input.acceptedAt === null || input.revokedAt !== null)) ||
      (input.status === 'revoked' &&
        (input.revokedAt === null || input.acceptedAt !== null))
    ) {
      return err(
        invalid('invitation state is invalid', 'invitation.invalid_state'),
      );
    }

    return ok(
      new Invitation({
        id: input.id,
        organizationId: input.organizationId,
        identityId: input.identityId,
        role: input.role,
        status: input.status,
        createdAt: copyDate(input.createdAt),
        updatedAt: copyDate(input.updatedAt),
        expiresAt: copyDate(input.expiresAt),
        acceptedAt:
          input.acceptedAt === null ? null : copyDate(input.acceptedAt),
        revokedAt: input.revokedAt === null ? null : copyDate(input.revokedAt),
        version: input.version,
      }),
    );
  }

  get id(): ID {
    return this.state.id;
  }
  get organizationId(): ID {
    return this.state.organizationId;
  }
  get identityId(): ID {
    return this.state.identityId;
  }
  get role(): InvitationRole {
    return this.state.role;
  }
  get status(): InvitationStatus {
    return this.state.status;
  }
  get createdAt(): Date {
    return copyDate(this.state.createdAt);
  }
  get updatedAt(): Date {
    return copyDate(this.state.updatedAt);
  }
  get expiresAt(): Date {
    return copyDate(this.state.expiresAt);
  }
  get acceptedAt(): Date | null {
    return this.state.acceptedAt === null
      ? null
      : copyDate(this.state.acceptedAt);
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
  saved(): Invitation {
    return new Invitation({ ...this.state, version: this.state.version + 1 });
  }

  isExpired(at: Date): boolean {
    return (
      validDate(at) &&
      this.status === 'pending' &&
      at.getTime() >= this.expiresAt.getTime()
    );
  }

  accept(at: Date): Result<Invitation, InvitationFailure> {
    const time = this.transitionTime(at);
    if (!time.ok) return time;
    if (this.status !== 'pending') {
      return err(
        invalid(
          'only pending invitations can be accepted',
          'invitation.not_pending',
        ),
      );
    }
    if (this.isExpired(time.value)) {
      return err(invalid('invitation has expired', 'invitation.expired'));
    }
    return ok(
      this.evolve({
        status: 'accepted',
        updatedAt: time.value,
        acceptedAt: time.value,
      }),
    );
  }

  revoke(at: Date): Result<Invitation, InvitationFailure> {
    const time = this.transitionTime(at);
    if (!time.ok) return time;
    if (this.status !== 'pending') {
      return err(
        invalid(
          'only pending invitations can be revoked',
          'invitation.not_pending',
        ),
      );
    }
    return ok(
      this.evolve({
        status: 'revoked',
        updatedAt: time.value,
        revokedAt: time.value,
      }),
    );
  }

  private transitionTime(at: Date): Result<Date, InvitationFailure> {
    if (!validDate(at))
      return err(
        invalid(
          'invitation transition time is invalid',
          'invitation.invalid_time',
        ),
      );
    if (at.getTime() < this.state.updatedAt.getTime()) {
      return err(
        invalid(
          'invitation transition time cannot move backwards',
          'invitation.non_monotonic_time',
        ),
      );
    }
    return ok(copyDate(at));
  }

  private evolve(patch: Partial<InvitationState>): Invitation {
    return new Invitation({
      ...this.state,
      status: patch.status ?? this.state.status,
      updatedAt: copyDate(patch.updatedAt ?? this.state.updatedAt),
      acceptedAt:
        patch.acceptedAt === undefined
          ? this.state.acceptedAt
          : patch.acceptedAt === null
            ? null
            : copyDate(patch.acceptedAt),
      revokedAt:
        patch.revokedAt === undefined
          ? this.state.revokedAt
          : patch.revokedAt === null
            ? null
            : copyDate(patch.revokedAt),
    });
  }
}
