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

export const MEMBERSHIP_ROLES = Object.freeze([
  'owner',
  'admin',
  'member',
] as const);

export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const MEMBERSHIP_STATUSES = Object.freeze([
  'active',
  'revoked',
] as const);

export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export type MembershipFailureType =
  | 'membership.invalid_role'
  | 'membership.invalid_created_at'
  | 'membership.invalid_state'
  | 'membership.non_monotonic_time'
  | 'membership.invalid_transition_time'
  | 'membership.revoked'
  | 'membership.already_revoked';

export type MembershipFailure = TypedFailure<'invalid', MembershipFailureType>;

export type AddMembershipInput = Readonly<{
  id: ID;
  organizationId: ID;
  identityId: ID;
  role: unknown;
  createdAt: Date;
}>;

export type RestoreMembershipInput = Readonly<{
  id: ID;
  organizationId: ID;
  identityId: ID;
  role: MembershipRole;
  status: MembershipStatus;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
  version: Version;
}>;

type MembershipState = Readonly<{
  id: ID;
  organizationId: ID;
  identityId: ID;
  role: MembershipRole;
  status: MembershipStatus;
  createdAt: Date;
  updatedAt: Date;
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
  type: MembershipFailureType,
): MembershipFailure {
  return typedFailure('invalid', type, message);
}

export class Membership {
  private constructor(private readonly state: MembershipState) {
    Object.freeze(this.state);
  }

  static add(input: AddMembershipInput): Result<Membership, MembershipFailure> {
    if (!MEMBERSHIP_ROLES.includes(input.role as MembershipRole)) {
      return err(
        invalid('membership role is invalid', 'membership.invalid_role'),
      );
    }

    if (!validDate(input.createdAt)) {
      return err(
        invalid(
          'membership creation time must be valid',
          'membership.invalid_created_at',
        ),
      );
    }

    const createdAt = copyDate(input.createdAt);
    return ok(
      new Membership({
        id: input.id,
        organizationId: input.organizationId,
        identityId: input.identityId,
        role: input.role as MembershipRole,
        status: 'active',
        createdAt,
        updatedAt: copyDate(createdAt),
        revokedAt: null,
        version: UNSAVED,
      }),
    );
  }

  static restore(
    input: RestoreMembershipInput,
  ): Result<Membership, MembershipFailure> {
    if (
      !MEMBERSHIP_ROLES.includes(input.role) ||
      !MEMBERSHIP_STATUSES.includes(input.status) ||
      !validDate(input.createdAt) ||
      !validDate(input.updatedAt) ||
      (input.revokedAt !== null && !validDate(input.revokedAt)) ||
      !isStoredVersion(input.version)
    ) {
      return err(
        invalid('membership state is invalid', 'membership.invalid_state'),
      );
    }

    if (input.updatedAt.getTime() < input.createdAt.getTime()) {
      return err(
        invalid(
          'membership update time cannot precede creation',
          'membership.non_monotonic_time',
        ),
      );
    }

    if (
      (input.status === 'active' && input.revokedAt !== null) ||
      (input.status === 'revoked' && input.revokedAt === null)
    ) {
      return err(
        invalid(
          'membership revocation state is invalid',
          'membership.invalid_state',
        ),
      );
    }

    return ok(
      new Membership({
        id: input.id,
        organizationId: input.organizationId,
        identityId: input.identityId,
        role: input.role,
        status: input.status,
        createdAt: copyDate(input.createdAt),
        updatedAt: copyDate(input.updatedAt),
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

  get role(): MembershipRole {
    return this.state.role;
  }

  get status(): MembershipStatus {
    return this.state.status;
  }

  get createdAt(): Date {
    return copyDate(this.state.createdAt);
  }

  get updatedAt(): Date {
    return copyDate(this.state.updatedAt);
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
  saved(): Membership {
    return new Membership({ ...this.state, version: this.state.version + 1 });
  }

  changeRole(role: unknown, at: Date): Result<Membership, MembershipFailure> {
    const time = this.transitionTime(at);
    if (!time.ok) return time;
    if (!MEMBERSHIP_ROLES.includes(role as MembershipRole)) {
      return err(
        invalid('membership role is invalid', 'membership.invalid_role'),
      );
    }
    if (this.status === 'revoked') {
      return err(
        invalid('revoked memberships cannot change role', 'membership.revoked'),
      );
    }

    return ok(
      this.evolve({ role: role as MembershipRole, updatedAt: time.value }),
    );
  }

  revoke(at: Date): Result<Membership, MembershipFailure> {
    const time = this.transitionTime(at);
    if (!time.ok) return time;
    if (this.status === 'revoked') {
      return err(
        invalid('membership is already revoked', 'membership.already_revoked'),
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

  private transitionTime(at: Date): Result<Date, MembershipFailure> {
    if (!validDate(at)) {
      return err(
        invalid(
          'membership transition time must be valid',
          'membership.invalid_transition_time',
        ),
      );
    }
    if (at.getTime() < this.state.updatedAt.getTime()) {
      return err(
        invalid(
          'membership transition time cannot move backwards',
          'membership.non_monotonic_time',
        ),
      );
    }
    return ok(copyDate(at));
  }

  private evolve(patch: Partial<MembershipState>): Membership {
    return new Membership({
      ...this.state,
      role: patch.role ?? this.state.role,
      status: patch.status ?? this.state.status,
      updatedAt: copyDate(patch.updatedAt ?? this.state.updatedAt),
      revokedAt:
        patch.revokedAt === undefined
          ? this.state.revokedAt
          : patch.revokedAt === null
            ? null
            : copyDate(patch.revokedAt),
    });
  }
}
