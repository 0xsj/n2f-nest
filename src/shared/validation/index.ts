import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';

const invalid = (code: string): Failure =>
  failure('invalid', 'invalid input', { type: `validation.${code}` });

export function text(
  value: unknown,
  min: number,
  max: number,
  required: boolean,
): Result<void, Failure> {
  if (
    !Number.isSafeInteger(min) ||
    !Number.isSafeInteger(max) ||
    min < 0 ||
    max < min
  ) {
    return err(invalid('policy'));
  }
  if (typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value)) {
    return err(invalid('text'));
  }

  const length = [...value].length;
  return length < min ||
    length > max ||
    (required && /^[ \t\r\n]*$/.test(value))
    ? err(invalid('text'))
    : ok(undefined);
}

export function decimal(
  value: unknown,
  min: number,
  max: number,
): Result<number, Failure> {
  if (
    !Number.isSafeInteger(min) ||
    !Number.isSafeInteger(max) ||
    min < 0 ||
    max < min ||
    max > 2147483647
  ) {
    return err(invalid('policy'));
  }
  if (
    typeof value !== 'string' ||
    value.length > 10 ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  ) {
    return err(invalid('decimal'));
  }

  const number = Number(value);
  return number < min || number > max
    ? err(invalid('decimal'))
    : ok(number);
}

export type Issue = Readonly<{
  field: string;
  code: string;
}>;

/** Operation-local builder; snapshots and failures own their field data. */
export class Report {
  #issues = new Map<string, string>();
  #truncated = false;

  add(field: unknown, code: unknown): Result<void, Failure> {
    if (
      typeof field !== 'string' ||
      typeof code !== 'string' ||
      !/^[A-Za-z0-9_.[\]-]{1,128}$/.test(field) ||
      !/^[a-z0-9_.]{1,64}$/.test(code)
    ) {
      return err(invalid('issue'));
    }
    if (this.#issues.has(field)) return ok(undefined);
    if (this.#issues.size === 32) {
      this.#truncated = true;
    } else {
      this.#issues.set(field, code);
    }
    return ok(undefined);
  }

  issues(): Issue[] {
    return [...this.#issues].map(([field, code]) => ({ field, code }));
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  result(): Result<void, Failure> {
    return this.#issues.size === 0
      ? ok(undefined)
      : err(
          failure('invalid', 'validation failed', {
            type: 'validation.failed',
            fields: Object.fromEntries(this.#issues),
          }),
        );
  }
}
