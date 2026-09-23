import {
  assertNever,
  typedFailure,
  type Failure,
  type TypedFailure,
} from '../../../shared/errors/index.js';
import type { DocumentFailure } from '../domain/index.js';

type KnownDocumentFailure =
  | TypedFailure<'forbidden', 'document.access_forbidden' | 'document.archive_forbidden'>
  | TypedFailure<'conflict', 'document.already_exists' | 'document.stale_write'>
  | TypedFailure<'unavailable', 'document.id_generation'>
  | TypedFailure<'invalid', 'document.invalid_operation' | 'document.invalid_page'>
  | TypedFailure<'not_found', 'document.not_found'>
  | TypedFailure<'internal', 'document.persistence_invalid'>
  | TypedFailure<'unauthenticated', 'document.missing_token'>
  | TypedFailure<'conflict', 'document.organization_mismatch'>;

type DependencyFailure =
  | TypedFailure<'internal', 'document.dependency_invalid' | 'document.dependency_internal'>
  | TypedFailure<'not_found', 'document.dependency_not_found'>
  | TypedFailure<'conflict', 'document.dependency_conflict'>
  | TypedFailure<'unauthenticated', 'document.dependency_unauthenticated'>
  | TypedFailure<'forbidden', 'document.dependency_forbidden'>
  | TypedFailure<'rate_limited', 'document.dependency_rate_limited'>
  | TypedFailure<'unavailable', 'document.dependency_unavailable'>
  | TypedFailure<'timeout', 'document.dependency_timeout'>
  | TypedFailure<'canceled', 'document.dependency_canceled'>;

export type DocumentApplicationFailure =
  | DocumentFailure
  | KnownDocumentFailure
  | DependencyFailure;

function knownFailure(error: Failure): KnownDocumentFailure | undefined {
  switch (error.type) {
    case 'document.access_forbidden':
    case 'document.archive_forbidden':
      return typedFailure('forbidden', error.type, error.message, { fields: error.fields, cause: error });
    case 'document.already_exists':
    case 'document.stale_write':
    case 'document.organization_mismatch':
      return typedFailure('conflict', error.type, error.message, { fields: error.fields, cause: error });
    case 'document.id_generation':
      return typedFailure('unavailable', error.type, error.message, { fields: error.fields, cause: error });
    case 'document.invalid_operation':
    case 'document.invalid_page':
      return typedFailure('invalid', error.type, error.message, { fields: error.fields, cause: error });
    case 'document.not_found':
      return typedFailure('not_found', error.type, error.message, { fields: error.fields, cause: error });
    case 'document.persistence_invalid':
      return typedFailure('internal', error.type, error.message, { fields: error.fields, cause: error });
    case 'document.missing_token':
      return typedFailure('unauthenticated', error.type, error.message, { fields: error.fields, cause: error });
    default:
      return undefined;
  }
}

export function dependencyFailure(error: Failure, operation: string): DocumentApplicationFailure {
  const known = knownFailure(error);
  if (known) return known;
  const details = { operation, cause: error.type ?? 'unknown' };
  switch (error.kind) {
    case 'invalid': return typedFailure('internal', 'document.dependency_invalid', 'Document dependency returned an invalid outcome', { details, cause: error });
    case 'not_found': return typedFailure('not_found', 'document.dependency_not_found', 'Document dependency could not find the required record', { details, cause: error });
    case 'conflict': return typedFailure('conflict', 'document.dependency_conflict', 'Document dependency rejected the operation as a conflict', { details, cause: error });
    case 'unauthenticated': return typedFailure('unauthenticated', 'document.dependency_unauthenticated', 'Document dependency rejected authentication', { details, cause: error });
    case 'forbidden': return typedFailure('forbidden', 'document.dependency_forbidden', 'Document dependency rejected authorization', { details, cause: error });
    case 'rate_limited': return typedFailure('rate_limited', 'document.dependency_rate_limited', 'Document dependency is rate limited', { details, cause: error });
    case 'unavailable': return typedFailure('unavailable', 'document.dependency_unavailable', 'Document dependency is unavailable', { details, cause: error });
    case 'timeout': return typedFailure('timeout', 'document.dependency_timeout', 'Document dependency timed out', { details, cause: error });
    case 'canceled': return typedFailure('canceled', 'document.dependency_canceled', 'Document dependency operation was canceled', { details, cause: error });
    case 'internal': return typedFailure('internal', 'document.dependency_internal', 'Document dependency failed internally', { details, cause: error });
    default: return assertNever(error);
  }
}

export function idGenerationFailure(error: Failure): DocumentApplicationFailure {
  return typedFailure('unavailable', 'document.id_generation', 'Document ID generation failed', {
    details: { cause: error.type ?? 'unknown' },
    cause: error,
  });
}

/** A page size or cursor the caller supplied is invalid or belongs to another list. */
export function invalidPage(): DocumentApplicationFailure {
  return typedFailure('invalid', 'document.invalid_page', 'page size or cursor is invalid');
}
