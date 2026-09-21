import {
  assertNever,
  typedFailure,
  type Failure,
  type TypedFailure,
} from '../../../shared/errors/index.js';
import type { AuditEntryFailure } from '../domain/index.js';

type KnownAuditFailure =
  | TypedFailure<'conflict', 'audit.event_id_reused'>
  | TypedFailure<'invalid', 'audit.invalid_subject'>
  | TypedFailure<'unavailable', 'audit.id_generation'>
  | TypedFailure<'internal', 'audit.persistence_invalid'>;

type DependencyFailure =
  | TypedFailure<'internal', 'audit.dependency_invalid' | 'audit.dependency_internal'>
  | TypedFailure<'not_found', 'audit.dependency_not_found'>
  | TypedFailure<'conflict', 'audit.dependency_conflict'>
  | TypedFailure<'unauthenticated', 'audit.dependency_unauthenticated'>
  | TypedFailure<'forbidden', 'audit.dependency_forbidden'>
  | TypedFailure<'rate_limited', 'audit.dependency_rate_limited'>
  | TypedFailure<'unavailable', 'audit.dependency_unavailable'>
  | TypedFailure<'timeout', 'audit.dependency_timeout'>
  | TypedFailure<'canceled', 'audit.dependency_canceled'>;

export type AuditApplicationFailure =
  | AuditEntryFailure
  | KnownAuditFailure
  | DependencyFailure;

function knownFailure(error: Failure): KnownAuditFailure | undefined {
  switch (error.type) {
    case 'audit.event_id_reused':
      return typedFailure('conflict', error.type, error.message, {
        fields: error.fields,
        cause: error,
      });
    case 'audit.invalid_subject':
      return typedFailure('invalid', error.type, error.message, {
        fields: error.fields,
        cause: error,
      });
    case 'audit.id_generation':
      return typedFailure('unavailable', error.type, error.message, {
        fields: error.fields,
        cause: error,
      });
    case 'audit.persistence_invalid':
      return typedFailure('internal', error.type, error.message, {
        fields: error.fields,
        cause: error,
      });
    default:
      return undefined;
  }
}

export function dependencyFailure(
  error: Failure,
  operation: string,
): AuditApplicationFailure {
  const known = knownFailure(error);
  if (known) return known;

  const details = { operation, cause: error.type ?? 'unknown' };
  switch (error.kind) {
    case 'invalid':
      return typedFailure('internal', 'audit.dependency_invalid', 'Audit dependency returned an invalid outcome', { details, cause: error });
    case 'not_found':
      return typedFailure('not_found', 'audit.dependency_not_found', 'Audit dependency could not find the required record', { details, cause: error });
    case 'conflict':
      return typedFailure('conflict', 'audit.dependency_conflict', 'Audit dependency rejected the operation as a conflict', { details, cause: error });
    case 'unauthenticated':
      return typedFailure('unauthenticated', 'audit.dependency_unauthenticated', 'Audit dependency rejected authentication', { details, cause: error });
    case 'forbidden':
      return typedFailure('forbidden', 'audit.dependency_forbidden', 'Audit dependency rejected authorization', { details, cause: error });
    case 'rate_limited':
      return typedFailure('rate_limited', 'audit.dependency_rate_limited', 'Audit dependency is rate limited', { details, cause: error });
    case 'unavailable':
      return typedFailure('unavailable', 'audit.dependency_unavailable', 'Audit dependency is unavailable', { details, cause: error });
    case 'timeout':
      return typedFailure('timeout', 'audit.dependency_timeout', 'Audit dependency timed out', { details, cause: error });
    case 'canceled':
      return typedFailure('canceled', 'audit.dependency_canceled', 'Audit dependency operation was canceled', { details, cause: error });
    case 'internal':
      return typedFailure('internal', 'audit.dependency_internal', 'Audit dependency failed internally', { details, cause: error });
    default:
      return assertNever(error);
  }
}

export function idGenerationFailure(error: Failure): AuditApplicationFailure {
  return typedFailure('unavailable', 'audit.id_generation', 'Audit ID generation failed', {
    details: { cause: error.type ?? 'unknown' },
    cause: error,
  });
}
