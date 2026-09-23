import {
  assertNever,
  typedFailure,
  type Failure,
  type TypedFailure,
} from '../../../shared/errors/index.js';
import type { JobFailure } from '../domain/index.js';

type KnownJobFailure =
  | TypedFailure<'forbidden', 'job.access_forbidden' | 'job.submit_forbidden' | 'job.transition_forbidden'>
  | TypedFailure<'conflict', 'job.already_exists' | 'job.stale_write' | 'job.subject_taken'>
  | TypedFailure<'unavailable', 'job.id_generation'>
  | TypedFailure<'invalid', 'job.invalid_operation' | 'job.invalid_page'>
  | TypedFailure<'not_found', 'job.not_found'>
  | TypedFailure<'conflict', 'job.organization_mismatch'>
  | TypedFailure<'internal', 'job.persistence_invalid'>
  | TypedFailure<'unauthenticated', 'jobs.missing_token'>;

type DependencyFailure =
  | TypedFailure<'internal', 'job.dependency_invalid' | 'job.dependency_internal'>
  | TypedFailure<'not_found', 'job.dependency_not_found'>
  | TypedFailure<'conflict', 'job.dependency_conflict'>
  | TypedFailure<'unauthenticated', 'job.dependency_unauthenticated'>
  | TypedFailure<'forbidden', 'job.dependency_forbidden'>
  | TypedFailure<'rate_limited', 'job.dependency_rate_limited'>
  | TypedFailure<'unavailable', 'job.dependency_unavailable'>
  | TypedFailure<'timeout', 'job.dependency_timeout'>
  | TypedFailure<'canceled', 'job.dependency_canceled'>;

export type JobsApplicationFailure = JobFailure | KnownJobFailure | DependencyFailure;

function knownFailure(error: Failure): KnownJobFailure | undefined {
  switch (error.type) {
    case 'job.access_forbidden':
    case 'job.submit_forbidden':
    case 'job.transition_forbidden':
      return typedFailure('forbidden', error.type, error.message, { fields: error.fields, cause: error });
    case 'job.already_exists':
    case 'job.stale_write':
    case 'job.subject_taken':
    case 'job.organization_mismatch':
      return typedFailure('conflict', error.type, error.message, { fields: error.fields, cause: error });
    case 'job.id_generation':
      return typedFailure('unavailable', error.type, error.message, { fields: error.fields, cause: error });
    case 'job.invalid_operation':
    case 'job.invalid_page':
      return typedFailure('invalid', error.type, error.message, { fields: error.fields, cause: error });
    case 'job.not_found':
      return typedFailure('not_found', error.type, error.message, { fields: error.fields, cause: error });
    case 'job.persistence_invalid':
      return typedFailure('internal', error.type, error.message, { fields: error.fields, cause: error });
    case 'jobs.missing_token':
      return typedFailure('unauthenticated', error.type, error.message, { fields: error.fields, cause: error });
    default:
      return undefined;
  }
}

export function dependencyFailure(error: Failure, operation: string): JobsApplicationFailure {
  const known = knownFailure(error);
  if (known) return known;
  const details = { operation, cause: error.type ?? 'unknown' };
  switch (error.kind) {
    case 'invalid': return typedFailure('internal', 'job.dependency_invalid', 'Job dependency returned an invalid outcome', { details, cause: error });
    case 'not_found': return typedFailure('not_found', 'job.dependency_not_found', 'Job dependency could not find the required record', { details, cause: error });
    case 'conflict': return typedFailure('conflict', 'job.dependency_conflict', 'Job dependency rejected the operation as a conflict', { details, cause: error });
    case 'unauthenticated': return typedFailure('unauthenticated', 'job.dependency_unauthenticated', 'Job dependency rejected authentication', { details, cause: error });
    case 'forbidden': return typedFailure('forbidden', 'job.dependency_forbidden', 'Job dependency rejected authorization', { details, cause: error });
    case 'rate_limited': return typedFailure('rate_limited', 'job.dependency_rate_limited', 'Job dependency is rate limited', { details, cause: error });
    case 'unavailable': return typedFailure('unavailable', 'job.dependency_unavailable', 'Job dependency is unavailable', { details, cause: error });
    case 'timeout': return typedFailure('timeout', 'job.dependency_timeout', 'Job dependency timed out', { details, cause: error });
    case 'canceled': return typedFailure('canceled', 'job.dependency_canceled', 'Job dependency operation was canceled', { details, cause: error });
    case 'internal': return typedFailure('internal', 'job.dependency_internal', 'Job dependency failed internally', { details, cause: error });
    default: return assertNever(error);
  }
}

export function idGenerationFailure(error: Failure): JobsApplicationFailure {
  return typedFailure('unavailable', 'job.id_generation', 'Job ID generation failed', {
    details: { cause: error.type ?? 'unknown' },
    cause: error,
  });
}

/** A page size or cursor the caller supplied is invalid or belongs to another list. */
export function invalidPage(): JobsApplicationFailure {
  return typedFailure('invalid', 'job.invalid_page', 'page size or cursor is invalid');
}
