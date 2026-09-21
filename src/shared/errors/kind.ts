/** Stable category names. Transport and retry policy belong to their owners. */
export const KINDS = Object.freeze([
  'internal',
  'invalid',
  'not_found',
  'conflict',
  'unauthenticated',
  'forbidden',
  'rate_limited',
  'unavailable',
  'timeout',
  'canceled',
] as const);

export type Kind = (typeof KINDS)[number];

/** Recognize an exact category name without classifying arbitrary input. */
export function parseKind(value: unknown): Kind | undefined {
  return typeof value === 'string' &&
    (KINDS as readonly string[]).includes(value)
    ? (value as Kind)
    : undefined;
}
