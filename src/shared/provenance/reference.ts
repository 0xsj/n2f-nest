import { err, ok, type Failure, type Result } from '../errors/index.js';
import { parse, type ID } from '../id/index.js';
import { invalid } from './actor.js';

export type ReferenceKind = 'scope' | 'work' | 'event';

export interface Reference {
  readonly kind: ReferenceKind;
  readonly id: ID;
}

const known = new WeakSet<object>();

export function validID(value: unknown): value is ID {
  const result = parse(value);
  return result.ok && result.value === value;
}

export const validReferenceKind = (value: unknown): value is ReferenceKind =>
  value === 'scope' || value === 'work' || value === 'event';

export function reference(
  kind: ReferenceKind,
  id: ID,
): Result<Reference, Failure> {
  if (!validReferenceKind(kind) || !validID(id)) {
    return err(invalid('invalid_reference'));
  }

  const value = Object.freeze({ kind, id });
  known.add(value);
  return ok(value);
}

export const validReference = (value: unknown): value is Reference =>
  typeof value === 'object' && value !== null && known.has(value);
