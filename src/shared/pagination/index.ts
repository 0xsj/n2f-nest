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

const MAX_SCOPE_BYTES = 128;
const MAX_POSITION_BYTES = 256;

/**
 * The longest cursor `encode` can issue. Parts exclude control characters, so
 * JSON escaping at most doubles their bytes (`"` and `\\`); the rest is the
 * `[1,"…","…"]` framing, then base64url's 4 characters per 3 bytes.
 */
const MAX_WIRE = Math.ceil(
  ((2 * MAX_SCOPE_BYTES + 2 * MAX_POSITION_BYTES + '[1,"",""]'.length) * 4) / 3,
);

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
  if (!validPart(scope, MAX_SCOPE_BYTES) || !validPart(position, MAX_POSITION_BYTES)) {
    return err(invalid());
  }
  const wire = Buffer.from(JSON.stringify([1, scope, position])).toString('base64url');
  // Never issue a cursor decode would refuse.
  return wire.length <= MAX_WIRE ? ok(wire) : err(invalid());
}

export function decode(
  wire: string,
  scope: string,
): Result<string, Failure> {
  if (
    typeof wire !== 'string' ||
    wire.length === 0 ||
    wire.length > MAX_WIRE ||
    !/^[A-Za-z0-9_-]+$/.test(wire) ||
    !validPart(scope, MAX_SCOPE_BYTES)
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
      validPart(value[2], MAX_POSITION_BYTES)
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

/** A keyset position after a row ordered by (time, id). */
export type After = Readonly<{ at: Date; id: string }>;

/** Encode a (time, id) keyset position for `encode`/`window`. */
export function position(at: Date, id: string): string {
  return `${at.toISOString()}|${id}`;
}

/** Read a position produced by `position`; undefined when malformed. */
export function after(value: string): After | undefined {
  const [iso, id, extra] = value.split('|');
  if (!iso || !id || extra !== undefined) return undefined;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) || at.toISOString() !== iso ? undefined : { at, id };
}

/**
 * Validate a page request from transport strings: `limit` (1–100, default
 * 25) and an optional cursor issued for the same `scope`.
 */
export function request(
  scope: string,
  limit?: string,
  cursor?: string,
): Result<Readonly<{ limit: number; after?: After }>, Failure> {
  const pageSize = size(limit);
  if (!pageSize.ok) return err(invalid());
  if (cursor === undefined) return ok({ limit: pageSize.value });
  const decoded = decode(cursor, scope);
  if (!decoded.ok) return decoded;
  const start = after(decoded.value);
  return start ? ok({ limit: pageSize.value, after: start }) : err(invalid());
}

/** Order by (time, id) with ordinal id comparison, as PostgreSQL orders UUIDs. */
export function compareKeyset(left: After, right: After): number {
  const time = left.at.getTime() - right.at.getTime();
  if (time !== 0) return time;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * The in-memory counterpart of a keyset query: rows after `page.after` in
 * (time, id) order, up to `limit + 1` so `window` can tell whether more exist.
 */
export function keysetPage<T>(
  rows: readonly T[],
  key: (row: T) => After,
  page: Readonly<{ limit: number; after?: After }>,
): T[] {
  return [...rows]
    .sort((left, right) => compareKeyset(key(left), key(right)))
    .filter((row) => !page.after || compareKeyset(key(row), page.after) > 0)
    .slice(0, page.limit + 1);
}
