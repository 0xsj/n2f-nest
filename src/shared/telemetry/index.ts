import { err, failure, ok, type Failure, type Result } from '../errors/index.js';

export type TraceSnapshot = Readonly<{
  traceId: string;
  spanId: string;
  sampled: boolean;
}>;

export type TraceRef = Readonly<{
  readonly __traceRef: unique symbol;
}>;

const refs = new WeakMap<object, TraceSnapshot>();

function valid(value: unknown, length: number): value is string {
  return (
    typeof value === 'string' &&
    value.length === length &&
    /^[0-9a-f]+$/.test(value) &&
    /[1-9a-f]/.test(value)
  );
}

export function traceRef(
  traceId: unknown,
  spanId: unknown,
  sampled: unknown,
): Result<TraceRef, Failure> {
  if (
    !valid(traceId, 32) ||
    !valid(spanId, 16) ||
    typeof sampled !== 'boolean'
  ) {
    return err(
      failure('invalid', 'invalid telemetry context', {
        type: 'telemetry.invalid_context',
      }),
    );
  }

  const ref = Object.freeze({}) as TraceRef;
  refs.set(ref, Object.freeze({ traceId, spanId, sampled }));
  return ok(ref);
}

export function parseTraceparent(value: unknown): Result<TraceRef, Failure> {
  if (typeof value !== 'string') {
    return err(
      failure('invalid', 'invalid traceparent', {
        type: 'telemetry.invalid_traceparent',
      }),
    );
  }

  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
  if (!match) {
    return err(
      failure('invalid', 'invalid traceparent', {
        type: 'telemetry.invalid_traceparent',
      }),
    );
  }

  const parsed = traceRef(
    match[1],
    match[2],
    (Number.parseInt(match[3], 16) & 1) === 1,
  );
  return parsed.ok
    ? parsed
    : err(
        failure('invalid', 'invalid traceparent', {
          type: 'telemetry.invalid_traceparent',
        }),
      );
}

export function formatTraceparent(ref: TraceRef): string {
  const value = snapshot(ref);
  return `00-${value.traceId}-${value.spanId}-${value.sampled ? '01' : '00'}`;
}

export function snapshot(ref: TraceRef): TraceSnapshot {
  const value = refs.get(ref as object);
  if (!value) {
    throw new TypeError('expected a TraceRef constructed by this module');
  }
  return { ...value };
}

export type Outcome =
  | 'success'
  | 'refused'
  | 'failed'
  | 'canceled'
  | 'timed_out';

const outcomes = new Set<Outcome>([
  'success',
  'refused',
  'failed',
  'canceled',
  'timed_out',
]);

export function parseOutcome(
  value: unknown,
): Result<Outcome, Failure> {
  if (typeof value !== 'string' || !outcomes.has(value as Outcome)) {
    return err(
      failure('invalid', 'invalid telemetry outcome', {
        type: 'telemetry.invalid_outcome',
      }),
    );
  }
  return ok(value as Outcome);
}
