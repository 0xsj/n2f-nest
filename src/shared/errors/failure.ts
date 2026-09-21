import { parseKind } from './kind.js';
import type { Kind } from './kind.js';

/** A discriminated value retaining narrow kind and optional condition literals. */
export type Failure<
  K extends Kind = Kind,
  T extends string = string,
> = K extends Kind
  ? Readonly<{
      kind: K;
      message: string;
      type?: T;
      fields?: Readonly<Record<string, string>>;
    }>
  : never;

/** A failure whose public type is a required, compile-time discriminant. */
export type TypedFailure<K extends Kind, T extends string> = T extends string
  ? Failure<K, T> & { readonly type: T }
  : never;

export type FailureOptions<T extends string = string> = {
  type?: T;
  fields?: Readonly<Record<string, string>>;
  details?: Readonly<Record<string, string>>;
  cause?: unknown;
};

export type PublicInfo = {
  kind: Kind;
  message: string;
  type?: string;
  fields?: Record<string, string>;
};

type Diagnostic = {
  readonly cause: unknown;
  readonly details: Readonly<Record<string, string>>;
};

const diagnostics = new WeakMap<object, Diagnostic>();
const carriers = new WeakMap<object, Failure>();

function trusted(value: unknown): Failure | undefined {
  if (
    (typeof value !== 'object' || value === null) &&
    typeof value !== 'function'
  ) {
    return undefined;
  }

  if (diagnostics.has(value)) return value as Failure;
  return carriers.get(value);
}

function requireFailure<F extends Failure>(value: F): F {
  const known = trusted(value);
  if (!known || known !== value) {
    throw new TypeError('expected a Failure constructed by this module');
  }
  return value;
}

function remember<F extends Failure>(value: F, diagnostic: Diagnostic): F {
  Object.freeze(value);
  diagnostics.set(value, diagnostic);
  return value;
}

/** Construct a frozen value with copied public and private metadata. */
export function failure<K extends Kind, const T extends string>(
  kind: K,
  message: string,
  options: FailureOptions<T> & { readonly type: T },
): TypedFailure<K, T>;
export function failure<K extends Kind, const T extends string = string>(
  kind: K,
  message: string,
  options?: FailureOptions<T>,
): Failure<K, T>;
export function failure<K extends Kind, const T extends string = string>(
  kind: K,
  message: string,
  options: FailureOptions<T> = {},
): Failure<K, T> {
  if (parseKind(kind) === undefined) {
    throw new TypeError('unknown failure kind');
  }

  const value = {
    kind,
    message,
    ...(options.type ? { type: options.type } : {}),
    ...(options.fields === undefined
      ? {}
      : { fields: Object.freeze({ ...options.fields }) }),
  } as Failure<K, T>;

  return remember(value, {
    cause: options.cause,
    details: Object.freeze({ ...options.details }),
  });
}

/** Construct a failure with a required type literal for exhaustive matching. */
export function typedFailure<K extends Kind, const T extends string>(
  kind: K,
  type: T,
  message: string,
  options: Omit<FailureOptions<T>, 'type'> = {},
): TypedFailure<K, T> {
  return failure(kind, message, { ...options, type }) as TypedFailure<K, T>;
}

/** Mark an unreachable exhaustive-match branch as a programmer error. */
export function assertNever(value: never): never {
  throw new Error(`unreachable value: ${String(value)}`);
}

/** Derive public fields without changing the original condition. */
export function withFields<F extends Failure>(
  value: F,
  fields: Readonly<Record<string, string>>,
): F {
  requireFailure(value);
  return remember(
    { ...value, fields: Object.freeze({ ...value.fields, ...fields }) },
    diagnostics.get(value)!,
  );
}

/** Derive a private diagnostic frame; new values win key collisions. */
export function withDetails<F extends Failure>(
  value: F,
  details: Readonly<Record<string, string>>,
): F {
  requireFailure(value);
  const previous = diagnostics.get(value)!;
  return remember(
    { ...value },
    {
      cause: previous.cause,
      details: Object.freeze({ ...previous.details, ...details }),
    },
  );
}

/** Construct an occurrence with a replacement cause, including undefined. */
export function withCause<F extends Failure>(value: F, cause: unknown): F {
  requireFailure(value);
  return remember(
    { ...value },
    { cause, details: diagnostics.get(value)!.details },
  );
}

export function kindOf(value: unknown): Kind | undefined {
  return trusted(value)?.kind;
}

/** Project an actual failure; Result success must be handled separately. */
export function publicInfo(value: unknown): PublicInfo {
  const known = trusted(value);
  if (!known || known.kind === 'internal') {
    return { kind: 'internal', message: 'internal error' };
  }

  return {
    kind: known.kind,
    message: known.message || 'request failed',
    ...(known.type ? { type: known.type } : {}),
    ...(known.fields === undefined ? {} : { fields: { ...known.fields } }),
  };
}

/** Copy the selected diagnostic frame, without merging inner causes. */
export function detailsOf(value: unknown): Record<string, string> {
  const known = trusted(value);
  return known ? { ...diagnostics.get(known)!.details } : {};
}

export function causeOf(value: unknown): unknown {
  const known = trusted(value);
  return known ? diagnostics.get(known)!.cause : undefined;
}

/** Normalize a caught failure without reading foreign getters or cause chains. */
export function fromCaught(value: unknown): Failure {
  return (
    trusted(value) ??
    failure('internal', 'unexpected failure', { cause: value })
  );
}

/** Framework-free carrier; a transport must provide its own exception mapping. */
export class AppError<F extends Failure = Failure> extends Error {
  constructor(readonly failure: F) {
    requireFailure(failure);
    super(failure.message, { cause: causeOf(failure) });
    this.name = 'AppError';
    carriers.set(this, failure);
  }
}
