import {
  assertNever,
  typedFailure,
  type Failure,
  type TypedFailure,
} from '../../../shared/errors/index.js';
import type {
  CredentialFailure,
  IdentityFailure as IdentityDomainFailure,
  SessionFailure,
  VerificationFailure,
} from '../domain/index.js';

type KnownIdentityFailure =
  | TypedFailure<
      'conflict',
      | 'identity.already_exists'
      | 'identity.email_taken'
      | 'identity.session_already_exists'
      | 'identity.challenge_already_exists'
      | 'identity.stale_write'
    >
  | TypedFailure<
      'invalid',
      | 'identity.password_too_short'
      | 'identity.password_too_long'
      | 'identity.invalid_session_expiry'
      | 'identity.invalid_verification_expiry'
    >
  | TypedFailure<
      'not_found',
      | 'identity.not_found'
      | 'identity.verification_not_found'
      | 'identity.session_not_found'
    >
  | TypedFailure<'unavailable', 'identity.incomplete_state'>;

type DependencyFailure =
  | TypedFailure<
      'internal',
      'identity.dependency_invalid' | 'identity.dependency_internal'
    >
  | TypedFailure<'not_found', 'identity.dependency_not_found'>
  | TypedFailure<'conflict', 'identity.dependency_conflict'>
  | TypedFailure<'unauthenticated', 'identity.dependency_unauthenticated'>
  | TypedFailure<'forbidden', 'identity.dependency_forbidden'>
  | TypedFailure<'rate_limited', 'identity.dependency_rate_limited'>
  | TypedFailure<'unavailable', 'identity.dependency_unavailable'>
  | TypedFailure<'timeout', 'identity.dependency_timeout'>
  | TypedFailure<'canceled', 'identity.dependency_canceled'>;

export type IdentityApplicationFailure =
  | IdentityDomainFailure
  | CredentialFailure
  | SessionFailure
  | VerificationFailure
  | KnownIdentityFailure
  | TypedFailure<
      'invalid',
      'identity.empty_password' | 'identity.invalid_request'
    >
  | TypedFailure<'not_found', 'identity.not_found'>
  | TypedFailure<
      'unauthenticated',
      | 'identity.invalid_credentials'
      | 'identity.invalid_verification_token'
      | 'identity.current_unavailable'
    >
  | TypedFailure<'conflict', 'identity.verification_unavailable'>
  | TypedFailure<'unavailable', 'identity.id_generation'>
  | TypedFailure<'internal', 'identity.invalid_session_state'>
  | DependencyFailure;

function knownFailure(error: Failure): KnownIdentityFailure | undefined {
  switch (error.type) {
    case 'identity.already_exists':
      return typedFailure('conflict', error.type, error.message, {
        fields: error.fields,
        cause: error,
      });
    case 'identity.email_taken':
      return typedFailure('conflict', error.type, error.message, {
        fields: error.fields,
        cause: error,
      });
    case 'identity.session_already_exists':
      return typedFailure('conflict', error.type, error.message, {
        fields: error.fields,
        cause: error,
      });
    case 'identity.challenge_already_exists':
      return typedFailure('conflict', error.type, error.message, {
        fields: error.fields,
        cause: error,
      });
    case 'identity.stale_write':
      return typedFailure('conflict', error.type, error.message, {
        fields: error.fields,
        cause: error,
      });
    case 'identity.password_too_short':
      return typedFailure('invalid', error.type, error.message, {
        fields: error.fields,
        cause: error,
      });
    case 'identity.password_too_long':
      return typedFailure('invalid', error.type, error.message, {
        fields: error.fields,
        cause: error,
      });
    case 'identity.invalid_session_expiry':
      return typedFailure('invalid', error.type, error.message, {
        fields: error.fields,
        cause: error,
      });
    case 'identity.invalid_verification_expiry':
      return typedFailure('invalid', error.type, error.message, {
        fields: error.fields,
        cause: error,
      });
    case 'identity.not_found':
      return typedFailure('not_found', error.type, error.message, {
        fields: error.fields,
        cause: error,
      });
    case 'identity.verification_not_found':
      return typedFailure('not_found', error.type, error.message, {
        fields: error.fields,
        cause: error,
      });
    case 'identity.session_not_found':
      return typedFailure('not_found', error.type, error.message, {
        fields: error.fields,
        cause: error,
      });
    case 'identity.incomplete_state':
      return typedFailure('unavailable', error.type, error.message, {
        fields: error.fields,
        cause: error,
      });
    default:
      return undefined;
  }
}

/** Normalize an open adapter failure into Identity's application contract. */
export function dependencyFailure(
  error: Failure,
  operation: string,
): IdentityApplicationFailure {
  const known = knownFailure(error);
  if (known) return known;

  const details = {
    operation,
    cause: error.type ?? 'unknown',
  };

  switch (error.kind) {
    case 'invalid':
      return typedFailure(
        'internal',
        'identity.dependency_invalid',
        'Identity dependency returned an invalid outcome',
        { details, cause: error },
      );
    case 'not_found':
      return typedFailure(
        'not_found',
        'identity.dependency_not_found',
        'Identity dependency could not find the required record',
        { details, cause: error },
      );
    case 'conflict':
      return typedFailure(
        'conflict',
        'identity.dependency_conflict',
        'Identity dependency rejected the operation as a conflict',
        { details, cause: error },
      );
    case 'unauthenticated':
      return typedFailure(
        'unauthenticated',
        'identity.dependency_unauthenticated',
        'Identity dependency rejected authentication',
        { details, cause: error },
      );
    case 'forbidden':
      return typedFailure(
        'forbidden',
        'identity.dependency_forbidden',
        'Identity dependency rejected authorization',
        { details, cause: error },
      );
    case 'rate_limited':
      return typedFailure(
        'rate_limited',
        'identity.dependency_rate_limited',
        'Identity dependency is rate limited',
        { details, cause: error },
      );
    case 'unavailable':
      return typedFailure(
        'unavailable',
        'identity.dependency_unavailable',
        'Identity dependency is unavailable',
        { details, cause: error },
      );
    case 'timeout':
      return typedFailure(
        'timeout',
        'identity.dependency_timeout',
        'Identity dependency timed out',
        { details, cause: error },
      );
    case 'canceled':
      return typedFailure(
        'canceled',
        'identity.dependency_canceled',
        'Identity dependency operation was canceled',
        { details, cause: error },
      );
    case 'internal':
      return typedFailure(
        'internal',
        'identity.dependency_internal',
        'Identity dependency failed internally',
        { details, cause: error },
      );
    default:
      return assertNever(error);
  }
}

export function idGenerationFailure(
  error: Failure,
): IdentityApplicationFailure {
  return typedFailure(
    'unavailable',
    'identity.id_generation',
    'Identity ID generation failed',
    {
      details: { cause: error.type ?? 'unknown' },
      cause: error,
    },
  );
}
