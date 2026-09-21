import { err, ok, type Failure, type Result } from '../errors/index.js';
import { invalid } from './actor.js';
import { validReference, type Reference } from './reference.js';

export type Relation = 'input' | 'replay_of' | 'previous_attempt';

export interface Link {
  readonly relation: Relation;
  readonly target: Reference;
}

const token = Symbol('links');

export class LinkSet {
  readonly #values: readonly Readonly<Link>[];

  constructor(key: typeof token, values: Link[]) {
    if (key !== token) throw new TypeError('use linkSet');
    this.#values = Object.freeze(
      values.map((value) => Object.freeze({ ...value })),
    );
    Object.freeze(this);
  }

  values(): Link[] {
    return this.#values.map((value) => ({ ...value }));
  }
}

export function linkSet(input: readonly Link[]): Result<LinkSet, Failure> {
  if (!Array.isArray(input)) return err(invalid('invalid_reference'));
  if (input.length > 32) return err(invalid('too_many_links'));

  const values: Link[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    if (
      !value ||
      !validReference(value.target) ||
      !['input', 'replay_of', 'previous_attempt'].includes(value.relation) ||
      (value.relation === 'previous_attempt' &&
        value.target.kind !== 'scope')
    ) {
      return err(invalid('invalid_reference'));
    }

    const key = `${value.relation}:${value.target.kind}:${value.target.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      values.push({ ...value });
    }
  }

  return ok(new LinkSet(token, values));
}
