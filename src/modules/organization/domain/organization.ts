import {
  err,
  ok,
  typedFailure,
  type TypedFailure,
  type Result,
} from '../../../shared/errors/index.js';
import type { ID } from '../../../shared/id/index.js';

export const ORGANIZATION_STATUSES = Object.freeze([
  'active',
  'suspended',
  'archived',
] as const);

export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export type OrganizationFailureType =
  | 'organization.invalid_name'
  | 'organization.invalid_slug'
  | 'organization.invalid_created_at'
  | 'organization.invalid_state'
  | 'organization.non_monotonic_time'
  | 'organization.archived'
  | 'organization.invalid_suspension'
  | 'organization.invalid_reactivation'
  | 'organization.already_archived'
  | 'organization.invalid_transition_time';

export type OrganizationFailure = TypedFailure<
  'invalid',
  OrganizationFailureType
>;

export type CreateOrganizationInput = Readonly<{
  id: ID;
  name: unknown;
  slug: unknown;
  createdAt: Date;
}>;

export type RestoreOrganizationInput = Readonly<{
  id: ID;
  name: unknown;
  slug: unknown;
  status: OrganizationStatus;
  createdAt: Date;
  updatedAt: Date;
}>;

type OrganizationState = Readonly<{
  id: ID;
  name: string;
  slug: string;
  status: OrganizationStatus;
  createdAt: Date;
  updatedAt: Date;
}>;

const MAX_NAME_LENGTH = 160;
const MAX_SLUG_LENGTH = 63;
const slugPattern = /^[a-z][a-z0-9-]{0,62}$/;

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function copyDate(value: Date): Date {
  return new Date(value.getTime());
}

function invalid(
  message: string,
  type: OrganizationFailureType,
): OrganizationFailure {
  return typedFailure('invalid', type, message);
}

function nameOf(input: unknown): Result<string, OrganizationFailure> {
  if (typeof input !== 'string') {
    return err(
      invalid(
        'organization name must be a string',
        'organization.invalid_name',
      ),
    );
  }

  const name = input.trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    return err(
      invalid('organization name is invalid', 'organization.invalid_name'),
    );
  }

  return ok(name);
}

function slugOf(input: unknown): Result<string, OrganizationFailure> {
  if (typeof input !== 'string') {
    return err(
      invalid(
        'organization slug must be a string',
        'organization.invalid_slug',
      ),
    );
  }

  const slug = input.trim().toLowerCase();
  if (slug.length > MAX_SLUG_LENGTH || !slugPattern.test(slug)) {
    return err(
      invalid('organization slug is invalid', 'organization.invalid_slug'),
    );
  }

  return ok(slug);
}

export class Organization {
  private constructor(private readonly state: OrganizationState) {
    Object.freeze(this.state);
  }

  static create(
    input: CreateOrganizationInput,
  ): Result<Organization, OrganizationFailure> {
    if (!validDate(input.createdAt)) {
      return err(
        invalid(
          'organization creation time must be valid',
          'organization.invalid_created_at',
        ),
      );
    }

    const name = nameOf(input.name);
    if (!name.ok) return name;

    const slug = slugOf(input.slug);
    if (!slug.ok) return slug;

    const createdAt = copyDate(input.createdAt);
    return ok(
      new Organization({
        id: input.id,
        name: name.value,
        slug: slug.value,
        status: 'active',
        createdAt,
        updatedAt: copyDate(createdAt),
      }),
    );
  }

  static restore(
    input: RestoreOrganizationInput,
  ): Result<Organization, OrganizationFailure> {
    if (
      !ORGANIZATION_STATUSES.includes(input.status) ||
      !validDate(input.createdAt) ||
      !validDate(input.updatedAt)
    ) {
      return err(
        invalid('organization state is invalid', 'organization.invalid_state'),
      );
    }

    if (input.updatedAt.getTime() < input.createdAt.getTime()) {
      return err(
        invalid(
          'organization update time cannot precede creation',
          'organization.non_monotonic_time',
        ),
      );
    }

    const name = nameOf(input.name);
    if (!name.ok) return name;

    const slug = slugOf(input.slug);
    if (!slug.ok) return slug;

    return ok(
      new Organization({
        id: input.id,
        name: name.value,
        slug: slug.value,
        status: input.status,
        createdAt: copyDate(input.createdAt),
        updatedAt: copyDate(input.updatedAt),
      }),
    );
  }

  get id(): ID {
    return this.state.id;
  }

  get name(): string {
    return this.state.name;
  }

  get slug(): string {
    return this.state.slug;
  }

  get status(): OrganizationStatus {
    return this.state.status;
  }

  get createdAt(): Date {
    return copyDate(this.state.createdAt);
  }

  get updatedAt(): Date {
    return copyDate(this.state.updatedAt);
  }

  rename(
    nameInput: unknown,
    at: Date,
  ): Result<Organization, OrganizationFailure> {
    const time = this.transitionTime(at);
    if (!time.ok) return time;

    if (this.status === 'archived') {
      return err(
        invalid(
          'archived organizations cannot be renamed',
          'organization.archived',
        ),
      );
    }

    const name = nameOf(nameInput);
    if (!name.ok) return name;

    return ok(this.evolve({ name: name.value, updatedAt: time.value }));
  }

  suspend(at: Date): Result<Organization, OrganizationFailure> {
    const time = this.transitionTime(at);
    if (!time.ok) return time;
    if (this.status !== 'active') {
      return err(
        invalid(
          'only active organizations can be suspended',
          'organization.invalid_suspension',
        ),
      );
    }

    return ok(this.evolve({ status: 'suspended', updatedAt: time.value }));
  }

  reactivate(at: Date): Result<Organization, OrganizationFailure> {
    const time = this.transitionTime(at);
    if (!time.ok) return time;
    if (this.status !== 'suspended') {
      return err(
        invalid(
          'only suspended organizations can be reactivated',
          'organization.invalid_reactivation',
        ),
      );
    }

    return ok(this.evolve({ status: 'active', updatedAt: time.value }));
  }

  archive(at: Date): Result<Organization, OrganizationFailure> {
    const time = this.transitionTime(at);
    if (!time.ok) return time;
    if (this.status === 'archived') {
      return err(
        invalid(
          'organization is already archived',
          'organization.already_archived',
        ),
      );
    }

    return ok(this.evolve({ status: 'archived', updatedAt: time.value }));
  }

  private transitionTime(at: Date): Result<Date, OrganizationFailure> {
    if (!validDate(at)) {
      return err(
        invalid(
          'organization transition time must be valid',
          'organization.invalid_transition_time',
        ),
      );
    }

    if (at.getTime() < this.state.updatedAt.getTime()) {
      return err(
        invalid(
          'organization transition time cannot move backwards',
          'organization.non_monotonic_time',
        ),
      );
    }

    return ok(copyDate(at));
  }

  private evolve(patch: Partial<OrganizationState>): Organization {
    return new Organization({
      id: this.state.id,
      name: patch.name ?? this.state.name,
      slug: patch.slug ?? this.state.slug,
      status: patch.status ?? this.state.status,
      createdAt: copyDate(patch.createdAt ?? this.state.createdAt),
      updatedAt: copyDate(patch.updatedAt ?? this.state.updatedAt),
    });
  }
}
