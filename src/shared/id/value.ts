import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';

declare const idBrand: unique symbol;

/** A canonical UUID value. Runtime validation enters through parse. */
export type ID = string & { readonly [idBrand]: true };

const canonical =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parse(input: unknown): Result<ID, Failure> {
  if (
    typeof input !== 'string' ||
    input.length !== 36 ||
    !canonical.test(input)
  ) {
    return err(failure('invalid', 'invalid ID', { type: 'id.invalid' }));
  }

  return ok(input.toLowerCase() as ID);
}

/** Read the UUID version from an already validated ID. */
export function version(id: ID): number {
  return Number.parseInt(id[14], 16);
}

/** Read the UUIDv7 Unix-millisecond field; other versions have no value here. */
export function unixMillis(id: ID): number | undefined {
  return version(id) === 7
    ? Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
    : undefined;
}

/** Internal UUIDv7 encoding helper; not part of the public barrel. */
export function encodeV7(
  milliseconds: number,
  counter: number,
  suffix: Uint8Array,
): ID {
  const stamp = milliseconds.toString(16).padStart(12, '0');
  const sequence = (0x7000 | counter).toString(16);
  const tail = Array.from(suffix, (byte, index) =>
    (index === 0 ? (byte & 0x3f) | 0x80 : byte)
      .toString(16)
      .padStart(2, '0'),
  ).join('');

  return `${stamp.slice(0, 8)}-${stamp.slice(8)}-${sequence}-${tail.slice(0, 4)}-${tail.slice(4)}` as ID;
}
