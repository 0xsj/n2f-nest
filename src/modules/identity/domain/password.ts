import { inspect } from 'node:util';
import {
  err,
  ok,
  failure,
  type Result,
  type Failure,
} from '../../../shared/errors/index.js';
import { SecretString } from '../../../shared/secret/index.js';
import { isWellFormed } from './bounds.js';
const invalid = () =>
  failure('invalid', 'invalid password', {
    type: 'identity.password_invalid',
  });
const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).length;
/** Common input ceiling before NFC; enrollment adds the post-NFC rule. */
const normalize = (input: SecretString): string | undefined => {
  if (!(input instanceof SecretString)) return undefined;
  const raw = input.reveal();
  if (typeof raw !== 'string' || !isWellFormed(raw)) return undefined;
  const size = bytes(raw);
  if (size < 1 || size > 4096) return undefined;
  const value = raw.normalize('NFC');
  return bytes(value) > 4096 ? undefined : value;
};
const enrollment = (value: string): boolean => {
  const scalars = [...value].length;
  return scalars >= 15 && scalars <= 128 && bytes(value) <= 512;
};
export class NewPassword {
  readonly #value: SecretString;
  private constructor(value: SecretString) {
    this.#value = value;
    Object.freeze(this);
  }
  static parse(input: SecretString): Result<NewPassword, Failure> {
    const value = normalize(input);
    return value === undefined || !enrollment(value)
      ? err(invalid())
      : ok(new NewPassword(new SecretString(value)));
  }
  secret(): SecretString {
    return this.#value;
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
export class PasswordInput {
  readonly #value: SecretString;
  private constructor(value: SecretString) {
    this.#value = value;
    Object.freeze(this);
  }
  static parse(input: SecretString): Result<PasswordInput, Failure> {
    const value = normalize(input);
    return value === undefined
      ? err(invalid())
      : ok(new PasswordInput(new SecretString(value)));
  }
  secret(): SecretString {
    return this.#value;
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
