import {
  assertNever,
  typedFailure,
  type Failure,
  type TypedFailure,
} from '../../../shared/errors/index.js';
import type {
  InvitationFailure,
  MembershipFailure,
  OrganizationFailure,
} from '../domain/index.js';

type KnownOrganizationFailure =
  | TypedFailure<'conflict',
      | 'organization.already_exists'
      | 'organization.invitation.acceptance_conflict'
      | 'organization.invitation.already_exists'
      | 'organization.invitation.membership_exists'
      | 'organization.invitation_exists'
      | 'organization.membership.already_exists'
      | 'organization.membership_exists'
      | 'organization.slug_taken'>
  | TypedFailure<'unavailable',
      | 'organization.id_generation'
      | 'organization.invitation.id_generation'
      | 'organization.membership.id_generation'>
  | TypedFailure<'invalid',
      | 'organization.invalid_operation'
      | 'organization.invitation.invalid_operation'
      | 'organization.membership.invalid_operation'>
  | TypedFailure<'forbidden',
      | 'organization.invitation.accept_forbidden'
      | 'organization.invitation.forbidden'
      | 'organization.invitation.revoke_forbidden'
      | 'organization.membership.add_forbidden'
      | 'organization.membership.owner_locked'
      | 'organization.membership.revoke_forbidden'
      | 'organization.membership.role_forbidden'>
  | TypedFailure<'not_found',
      | 'organization.invitation.identity_not_found'
      | 'organization.invitation.not_found'
      | 'organization.membership.identity_not_found'
      | 'organization.membership.not_found'>
  | TypedFailure<'unauthenticated', 'organization.missing_token'>
  | TypedFailure<'internal', 'organization.persistence_invalid'>;

type DependencyFailure =
  | TypedFailure<'internal', 'organization.dependency_invalid' | 'organization.dependency_internal'>
  | TypedFailure<'not_found', 'organization.dependency_not_found'>
  | TypedFailure<'conflict', 'organization.dependency_conflict'>
  | TypedFailure<'unauthenticated', 'organization.dependency_unauthenticated'>
  | TypedFailure<'forbidden', 'organization.dependency_forbidden'>
  | TypedFailure<'rate_limited', 'organization.dependency_rate_limited'>
  | TypedFailure<'unavailable', 'organization.dependency_unavailable'>
  | TypedFailure<'timeout', 'organization.dependency_timeout'>
  | TypedFailure<'canceled', 'organization.dependency_canceled'>;

export type OrganizationApplicationFailure =
  | OrganizationFailure
  | MembershipFailure
  | InvitationFailure
  | KnownOrganizationFailure
  | DependencyFailure;

function knownFailure(error: Failure): KnownOrganizationFailure | undefined {
  switch (error.type) {
    case 'organization.already_exists':
    case 'organization.invitation.acceptance_conflict':
    case 'organization.invitation.already_exists':
    case 'organization.invitation.membership_exists':
    case 'organization.invitation_exists':
    case 'organization.membership.already_exists':
    case 'organization.membership_exists':
    case 'organization.slug_taken':
      return typedFailure('conflict', error.type, error.message, { fields: error.fields, cause: error });
    case 'organization.id_generation':
    case 'organization.invitation.id_generation':
    case 'organization.membership.id_generation':
      return typedFailure('unavailable', error.type, error.message, { fields: error.fields, cause: error });
    case 'organization.invalid_operation':
    case 'organization.invitation.invalid_operation':
    case 'organization.membership.invalid_operation':
      return typedFailure('invalid', error.type, error.message, { fields: error.fields, cause: error });
    case 'organization.invitation.accept_forbidden':
    case 'organization.invitation.forbidden':
    case 'organization.invitation.revoke_forbidden':
    case 'organization.membership.add_forbidden':
    case 'organization.membership.owner_locked':
    case 'organization.membership.revoke_forbidden':
    case 'organization.membership.role_forbidden':
      return typedFailure('forbidden', error.type, error.message, { fields: error.fields, cause: error });
    case 'organization.invitation.identity_not_found':
    case 'organization.invitation.not_found':
    case 'organization.membership.identity_not_found':
    case 'organization.membership.not_found':
      return typedFailure('not_found', error.type, error.message, { fields: error.fields, cause: error });
    case 'organization.missing_token':
      return typedFailure('unauthenticated', error.type, error.message, { fields: error.fields, cause: error });
    case 'organization.persistence_invalid':
      return typedFailure('internal', error.type, error.message, { fields: error.fields, cause: error });
    default:
      return undefined;
  }
}

export function dependencyFailure(error: Failure, operation: string): OrganizationApplicationFailure {
  const known = knownFailure(error);
  if (known) return known;
  const details = { operation, cause: error.type ?? 'unknown' };
  switch (error.kind) {
    case 'invalid': return typedFailure('internal', 'organization.dependency_invalid', 'Organization dependency returned an invalid outcome', { details, cause: error });
    case 'not_found': return typedFailure('not_found', 'organization.dependency_not_found', 'Organization dependency could not find the required record', { details, cause: error });
    case 'conflict': return typedFailure('conflict', 'organization.dependency_conflict', 'Organization dependency rejected the operation as a conflict', { details, cause: error });
    case 'unauthenticated': return typedFailure('unauthenticated', 'organization.dependency_unauthenticated', 'Organization dependency rejected authentication', { details, cause: error });
    case 'forbidden': return typedFailure('forbidden', 'organization.dependency_forbidden', 'Organization dependency rejected authorization', { details, cause: error });
    case 'rate_limited': return typedFailure('rate_limited', 'organization.dependency_rate_limited', 'Organization dependency is rate limited', { details, cause: error });
    case 'unavailable': return typedFailure('unavailable', 'organization.dependency_unavailable', 'Organization dependency is unavailable', { details, cause: error });
    case 'timeout': return typedFailure('timeout', 'organization.dependency_timeout', 'Organization dependency timed out', { details, cause: error });
    case 'canceled': return typedFailure('canceled', 'organization.dependency_canceled', 'Organization dependency operation was canceled', { details, cause: error });
    case 'internal': return typedFailure('internal', 'organization.dependency_internal', 'Organization dependency failed internally', { details, cause: error });
    default: return assertNever(error);
  }
}

export function idGenerationFailure(error: Failure, type: 'organization.id_generation' | 'organization.invitation.id_generation' | 'organization.membership.id_generation'): OrganizationApplicationFailure {
  return typedFailure('unavailable', type, 'Organization ID generation failed', {
    details: { cause: error.type ?? 'unknown' },
    cause: error,
  });
}
