import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';
import type { ID } from './value.js';
import type { IDGenerator } from './v7.js';

/** Finite deterministic fixtures. Input ownership is copied; duplicates are allowed. */
export class Sequence implements IDGenerator {
  readonly #ids: readonly ID[];
  #next = 0;

  constructor(ids: readonly ID[]) {
    this.#ids = [...ids];
  }

  newId(): Result<ID, Failure> {
    if (this.#next >= this.#ids.length) {
      return err(
        failure('unavailable', 'ID sequence exhausted', {
          type: 'id.sequence_exhausted',
        }),
      );
    }

    return ok(this.#ids[this.#next++]);
  }
}
