import {
  err,
  ok,
  typedFailure,
  type TypedFailure,
  type Result,
} from '../../../shared/errors/index.js';
import type { ID } from '../../../shared/id/index.js';

export const CREDENTIAL_METHODS = Object.freeze(['email_password'] as const);

export type CredentialMethod = (typeof CREDENTIAL_METHODS)[number];

export const CREDENTIAL_STATUSES = Object.freeze([
  'active',
  'revoked',
] as const);

export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

export type CredentialFailureType =
  | 'credential.invalid_email'
  | 'credential.invalid_created_at'
  | 'credential.invalid_state'
  | 'credential.non_monotonic_time'
  | 'credential.invalid_revocation_time'
  | 'credential.already_revoked'
  | 'credential.invalid_change_time'
  | 'credential.revoked';

export type CredentialFailure = TypedFailure<'invalid', CredentialFailureType>;

declare const emailAddressBrand: unique symbol;

export type EmailAddress = string & {
  readonly [emailAddressBrand]: true;
};

export type CreateEmailPasswordCredentialInput = Readonly<{
  id: ID;
  identityId: ID;
  email: unknown;
  createdAt: Date;
}>;

export type RestoreCredentialInput = Readonly<{
  id: ID;
  identityId: ID;
  method: CredentialMethod;
  email: unknown;
  status: CredentialStatus;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
}>;

type CredentialState = Readonly<{
  id: ID;
  identityId: ID;
  method: CredentialMethod;
  email: EmailAddress;
  status: CredentialStatus;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
}>;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function copyDate(value: Date): Date {
  return new Date(value.getTime());
}

function invalid<const T extends CredentialFailureType>(
  message: string,
  type: T,
): TypedFailure<'invalid', T> {
  return typedFailure('invalid', type, message);
}

export function normalizeEmail(
  input: unknown,
): Result<EmailAddress, CredentialFailure> {
  if (typeof input !== 'string') {
    return err(invalid('email must be a string', 'credential.invalid_email'));
  }

  const normalized = input.trim().toLowerCase();

  if (
    normalized.length === 0 ||
    normalized.length > 254 ||
    !emailPattern.test(normalized)
  ) {
    return err(
      invalid('email must be a valid address', 'credential.invalid_email'),
    );
  }

  return ok(normalized as EmailAddress);
}

export class Credential {
  private constructor(private readonly state: CredentialState) {
    Object.freeze(this.state);
  }

  static createEmailPassword(
    input: CreateEmailPasswordCredentialInput,
  ): Result<Credential, CredentialFailure> {
    if (!validDate(input.createdAt)) {
      return err(
        invalid(
          'credential creation time must be valid',
          'credential.invalid_created_at',
        ),
      );
    }

    const email = normalizeEmail(input.email);

    if (!email.ok) {
      return email;
    }

    const createdAt = copyDate(input.createdAt);

    return ok(
      new Credential({
        id: input.id,
        identityId: input.identityId,
        method: 'email_password',
        email: email.value,
        status: 'active',
        createdAt,
        updatedAt: copyDate(createdAt),
        revokedAt: null,
      }),
    );
  }

  static restore(
    input: RestoreCredentialInput,
  ): Result<Credential, CredentialFailure> {
    if (
      !CREDENTIAL_METHODS.includes(input.method) ||
      !CREDENTIAL_STATUSES.includes(input.status) ||
      !validDate(input.createdAt) ||
      !validDate(input.updatedAt) ||
      (input.revokedAt !== null && !validDate(input.revokedAt))
    ) {
      return err(
        invalid('credential state is invalid', 'credential.invalid_state'),
      );
    }

    const email = normalizeEmail(input.email);
    if (!email.ok) return email;

    if (input.updatedAt.getTime() < input.createdAt.getTime()) {
      return err(
        invalid(
          'credential update time cannot precede creation',
          'credential.non_monotonic_time',
        ),
      );
    }

    if (
      (input.status === 'active' && input.revokedAt !== null) ||
      (input.status === 'revoked' && input.revokedAt === null)
    ) {
      return err(
        invalid(
          'credential revocation state is invalid',
          'credential.invalid_state',
        ),
      );
    }

    return ok(
      new Credential({
        id: input.id,
        identityId: input.identityId,
        method: input.method,
        email: email.value,
        status: input.status,
        createdAt: copyDate(input.createdAt),
        updatedAt: copyDate(input.updatedAt),
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

  get method(): CredentialMethod {
    return this.state.method;
  }

  get email(): EmailAddress {
    return this.state.email;
  }

  get status(): CredentialStatus {
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

  revoke(at: Date): Result<Credential, CredentialFailure> {
    if (!validDate(at)) {
      return err(
        invalid(
          'credential revocation time must be valid',
          'credential.invalid_revocation_time',
        ),
      );
    }

    if (at.getTime() < this.state.updatedAt.getTime()) {
      return err(
        invalid(
          'credential transition time cannot move backwards',
          'credential.non_monotonic_time',
        ),
      );
    }

    if (this.status === 'revoked') {
      return err(
        invalid('credential is already revoked', 'credential.already_revoked'),
      );
    }

    const revokedAt = copyDate(at);

    return ok(
      new Credential({
        ...this.state,
        status: 'revoked',
        updatedAt: copyDate(revokedAt),
        revokedAt: copyDate(revokedAt),
      }),
    );
  }

  /**
   * This credential with a new secret set at `at`. The secret itself is not
   * domain state; `updatedAt` records the change and moves strictly forward,
   * so storage can use it to detect a concurrent change (a login that checked
   * the previous password, or another reset).
   */
  changeSecret(at: Date): Result<Credential, CredentialFailure> {
    if (!validDate(at)) {
      return err(
        invalid('credential change time must be valid', 'credential.invalid_change_time'),
      );
    }

    if (at.getTime() <= this.state.updatedAt.getTime()) {
      return err(
        invalid(
          'credential transition time cannot move backwards',
          'credential.non_monotonic_time',
        ),
      );
    }

    if (this.status === 'revoked') {
      return err(invalid('credential is revoked', 'credential.revoked'));
    }

    return ok(new Credential({ ...this.state, updatedAt: copyDate(at) }));
  }
}
