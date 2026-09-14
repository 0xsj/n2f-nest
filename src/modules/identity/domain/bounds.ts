/** Common numeric bounds shared by the auth leaves; see AUTH_CONTRACT.md A04–A09. */
export const MAX_TIME_MS = 253402300799999;
export const MAX_VERSION = 2147483647;
export const isTime = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_TIME_MS;
export const isVersion = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= MAX_VERSION;
/** Absent (undefined) is distinct from present zero; null is malformed. */
export const isOptionalTime = (v: unknown): v is number | undefined =>
  v === undefined || isTime(v);
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;
/**
 * Lone surrogates are the JavaScript form of malformed Unicode. Iterating by
 * code point yields a paired surrogate as one value above 0xffff and a lone
 * one as its own code unit, so the range test finds exactly the malformed ones.
 * The compiler lib (ES2023) predates String.prototype.isWellFormed.
 */
export const isWellFormed = (s: string): boolean => {
  for (const c of s) {
    const p = c.codePointAt(0) as number;
    if (p >= 0xd800 && p <= 0xdfff) return false;
  }
  return true;
};
