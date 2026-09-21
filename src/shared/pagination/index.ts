/** Bounded pages and query-bound opaque cursors; encoding is not authorization. */
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';
import { decimal } from '../validation/index.js';

const invalid = () =>
  failure('invalid', 'invalid pagination', { type: 'pagination.invalid' });

export const size = (raw?: string): Result<number, Failure> =>
  raw === undefined ? ok(25) : decimal(raw, 1, 100);

function validPart(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    !/[\uD800-\uDFFF]/u.test(value) &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maxBytes &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

export function encode(
  scope: string,
  position: string,
): Result<string, Failure> {
  return validPart(scope, 128) && validPart(position, 256)
    ? ok(Buffer.from(JSON.stringify([1, scope, position])).toString('base64url'))
    : err(invalid());
}

export function decode(
  wire: string,
  scope: string,
): Result<string, Failure> {
  if (
    typeof wire !== 'string' ||
    wire.length === 0 ||
    wire.length > 1024 ||
    !/^[A-Za-z0-9_-]+$/.test(wire) ||
    !validPart(scope, 128)
  ) {
    return err(invalid());
  }

  try {
    const bytes = Buffer.from(wire, 'base64url');
    if (bytes.toString('base64url') !== wire) return err(invalid());
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    return Array.isArray(value) &&
      value.length === 3 &&
      value[0] === 1 &&
      value[1] === scope &&
      validPart(value[2], 256)
      ? ok(value[2])
      : err(invalid());
  } catch {
    return err(invalid());
  }
}

export type Page<T> = {
  items: T[];
  hasMore: boolean;
  nextCursor?: string;
};

export function window<T>(
  rows: readonly T[],
  limit: number,
  scope: string,
  position: (row: T) => string,
): Result<Page<T>, Failure> {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    rows.length > limit + 1
  ) {
    return err(invalid());
  }

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  if (!hasMore) return ok({ items, hasMore });

  const next = encode(scope, position(items[items.length - 1]));
  return next.ok ? ok({ items, hasMore, nextCursor: next.value }) : next;
}
