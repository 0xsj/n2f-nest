/**
 * Framework-free failure values shared by domains, application services and
 * adapters. Transport-specific response mapping belongs outside this module.
 *
 * Kind is a closed vocabulary. A module-specific `type` identifies the local
 * condition, while `message` and `fields` are deliberately public data. Cause
 * and details are diagnostic-only and are never included by `publicInfo`.
 */
export { KINDS, parseKind } from './kind.js';
export type { Kind } from './kind.js';

export { err, mapError, ok } from './result.js';
export type { Result } from './result.js';

export {
  AppError,
  assertNever,
  causeOf,
  detailsOf,
  failure,
  fromCaught,
  kindOf,
  publicInfo,
  typedFailure,
  withCause,
  withDetails,
  withFields,
} from './failure.js';
export type {
  Failure,
  FailureOptions,
  PublicInfo,
  TypedFailure,
} from './failure.js';
