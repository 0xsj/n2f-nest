import { inspect } from 'node:util';
import {
  err,
  ok,
  failure,
  type Result,
  type Failure,
} from '../../../shared/errors/index.js';
export type TokenPurpose =
  'session' | 'email_verification' | 'password_reset' | 'websocket_upgrade';
const purposes: readonly string[] = Object.freeze([
  'session',
  'email_verification',
  'password_reset',
  'websocket_upgrade',
]);
const invalid = () =>
  failure('invalid', 'invalid token', { type: 'identity.token_invalid' });
export const isTokenPurpose = (value: unknown): value is TokenPurpose =>
  typeof value === 'string' && purposes.includes(value);
export const parseTokenPurpose = (
  value: string,
): Result<TokenPurpose, Failure> =>
  isTokenPurpose(value) ? ok(value) : err(invalid());
/** Validated purpose plus exactly 32 owned digest bytes; never a raw token. */
export class TokenDigest {
  readonly #purpose: TokenPurpose;
  readonly #data: Uint8Array;
  private constructor(purpose: TokenPurpose, data: Uint8Array) {
    this.#purpose = purpose;
    this.#data = data.slice();
    Object.freeze(this);
  }
  static parse(
    purpose: TokenPurpose,
    data: Uint8Array,
  ): Result<TokenDigest, Failure> {
    if (
      !isTokenPurpose(purpose) ||
      !(data instanceof Uint8Array) ||
      data.length !== 32
    )
      return err(invalid());
    return ok(new TokenDigest(purpose, data));
  }
  /** True only for an instance whose purpose and size are still valid. */
  static valid(value: unknown): value is TokenDigest {
    return (
      value instanceof TokenDigest &&
      isTokenPurpose(value.#purpose) &&
      value.#data instanceof Uint8Array &&
      value.#data.length === 32
    );
  }
  purpose(): TokenPurpose {
    return this.#purpose;
  }
  bytes(): Uint8Array {
    return this.#data.slice();
  }
  toString(): string {
    return '[REDACTED]';
  }
  toJSON(): string {
    return '[REDACTED]';
  }
  [Symbol.toPrimitive](): string {
    return '[REDACTED]';
  }
  [inspect.custom](): string {
    return '[REDACTED]';
  }
}
