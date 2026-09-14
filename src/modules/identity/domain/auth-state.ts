import {
  err,
  ok,
  failure,
  type Result,
  type Failure,
} from '../../../shared/errors/index.js';
import { parse, type ID } from '../../../shared/id/index.js';
import { MAX_VERSION, isVersion } from './bounds.js';
const invalid = () =>
  failure('invalid', 'invalid auth state', {
    type: 'identity.auth_state_invalid',
  });
const conflict = (type: string) =>
  failure('conflict', 'auth epoch transition refused', { type });
/** Principal security epoch; incrementing it invalidates every session. */
export class AuthState {
  readonly #principalId: ID;
  readonly #epoch: number;
  private constructor(principalId: ID, epoch: number) {
    this.#principalId = principalId;
    this.#epoch = epoch;
    Object.freeze(this);
  }
  static create(principalId: ID, epoch: number): Result<AuthState, Failure> {
    const id = parse(principalId);
    if (!id.ok || !isVersion(epoch)) return err(invalid());
    return ok(new AuthState(id.value, epoch));
  }
  principalId(): ID {
    return this.#principalId;
  }
  epoch(): number {
    return this.#epoch;
  }
  invalidate(expected: number): Result<AuthState, Failure> {
    if (!parse(this.#principalId).ok || !isVersion(this.#epoch))
      return err(invalid());
    if (expected !== this.#epoch)
      return err(conflict('identity.version_conflict'));
    if (this.#epoch === MAX_VERSION)
      return err(conflict('identity.version_exhausted'));
    return ok(new AuthState(this.#principalId, this.#epoch + 1));
  }
}
