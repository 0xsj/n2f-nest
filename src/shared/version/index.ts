/**
 * Optimistic-concurrency token for a persisted aggregate.
 *
 * An aggregate carries the version it was loaded at. State transitions keep
 * that version, so a writer can update only when storage still holds it and
 * refuse a write whose read has gone stale. A new aggregate is `UNSAVED`;
 * storage assigns `FIRST` on insert and increments on every update.
 */
export type Version = number;

export const UNSAVED: Version = 0;
export const FIRST: Version = 1;

/** Recognize a version that storage could have produced. */
export function isStoredVersion(value: unknown): value is Version {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= FIRST;
}
