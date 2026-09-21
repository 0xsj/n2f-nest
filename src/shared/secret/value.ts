import { inspect } from 'node:util';

/** Private text with explicit reveal and redacted ordinary presentation. */
export class SecretString {
  readonly #value: string;

  constructor(value: string) {
    if (typeof value !== 'string') {
      throw new TypeError('secret requires a string');
    }
    this.#value = value;
    Object.freeze(this);
  }

  reveal(): string {
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
