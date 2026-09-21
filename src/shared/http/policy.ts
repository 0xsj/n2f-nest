import {
  err,
  failure,
  ok,
  parseKind,
  type Failure,
  type Kind,
  type Result,
} from '../errors/index.js';
import type { Outcome } from '../telemetry/index.js';

export type { Outcome } from '../telemetry/index.js';

export type Termination =
  | 'response_completed'
  | 'peer_closed'
  | 'deadline'
  | 'handler_error'
  | 'write_error'
  | 'abandoned';

export type CompletionFacts = Readonly<{
  status?: number;
  failureKind?: Kind;
  termination: Termination;
}>;

export type Classification = Readonly<{
  outcome: Outcome;
  spanError: boolean;
  errorType?: string;
}>;

export function normalizeMethod(value: string): string {
  return [
    'GET',
    'HEAD',
    'POST',
    'PUT',
    'DELETE',
    'CONNECT',
    'OPTIONS',
    'TRACE',
    'PATCH',
  ].includes(value)
    ? value
    : '_OTHER';
}

export function classifyCompletion(
  facts: CompletionFacts,
): Result<Classification, Failure> {
  const invalid = () =>
    err(
      failure('invalid', 'invalid HTTP completion', {
        type: 'http.invalid_completion',
      }),
    );
  if (!facts || typeof facts !== 'object') return invalid();
  if (
    facts.status !== undefined &&
    (!Number.isInteger(facts.status) || facts.status < 200 || facts.status > 599)
  ) {
    return invalid();
  }
  if (
    facts.failureKind !== undefined &&
    parseKind(facts.failureKind) === undefined
  ) {
    return invalid();
  }
  if (
    facts.termination === 'response_completed' &&
    facts.status === undefined
  ) {
    return invalid();
  }

  let outcome: Outcome;
  let errorType: string | undefined;
  switch (facts.termination) {
    case 'peer_closed':
      outcome = 'canceled';
      errorType = 'canceled';
      break;
    case 'deadline':
      outcome = 'timed_out';
      errorType = 'timeout';
      break;
    case 'handler_error':
    case 'write_error':
    case 'abandoned':
      outcome = 'failed';
      errorType = facts.termination;
      break;
    case 'response_completed':
      if (facts.failureKind === 'timeout') {
        outcome = 'timed_out';
        errorType = 'timeout';
      } else if (facts.failureKind === 'canceled') {
        outcome = 'canceled';
        errorType = 'canceled';
      } else if (
        facts.failureKind === 'internal' ||
        facts.failureKind === 'unavailable'
      ) {
        outcome = 'failed';
      } else if (facts.failureKind !== undefined) {
        outcome = 'refused';
      } else {
        outcome =
          facts.status! >= 500
            ? 'failed'
            : facts.status! >= 400
              ? 'refused'
              : 'success';
      }
      break;
    default:
      return invalid();
  }

  const spanError =
    facts.termination !== 'response_completed' ||
    (facts.status !== undefined && facts.status >= 500) ||
    ['failed', 'canceled', 'timed_out'].includes(outcome);
  if (errorType === undefined && spanError) {
    errorType =
      facts.status !== undefined && facts.status >= 500
        ? String(facts.status)
        : 'handler_error';
  }
  return ok(
    Object.freeze({
      outcome,
      spanError,
      ...(errorType === undefined ? {} : { errorType }),
    }),
  );
}
