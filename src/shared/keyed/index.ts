/**
 * HMAC-SHA256 over a purpose label, a zero separator and a message. This leaf
 * carries no policy about whether a digest is a token, subject key or CSRF tag.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';
import { err, failure, ok, type Failure, type Result } from '../errors/index.js';
import { SecretString } from '../secret/index.js';

const MIN_KEY_BYTES = 32;
const TAG_BYTES = 32;
const MAX_PURPOSE = 64;

const configuration = (): Failure =>
  failure('invalid', 'invalid keyed digest configuration', {
    type: 'keyed.configuration',
  });

const purposeInvalid = (): Failure =>
  failure('invalid', 'invalid keyed digest purpose', {
    type: 'keyed.purpose_invalid',
  });

const messageInvalid = (): Failure =>
  failure('invalid', 'invalid keyed digest message', {
    type: 'keyed.message_invalid',
  });

export function validPurpose(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PURPOSE &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

export class Digest {
  readonly #key: Buffer;

  private constructor(key: Buffer) {
    this.#key = key;
    Object.freeze(this);
  }

  static create(key: SecretString): Result<Digest, Failure> {
    if (!(key instanceof SecretString)) return err(configuration());
    const bytes = Buffer.from(key.reveal(), 'utf8');
    return bytes.length < MIN_KEY_BYTES
      ? err(configuration())
      : ok(new Digest(bytes));
  }

  sign(
    purpose: string,
    message: Uint8Array,
  ): Result<Uint8Array, Failure> {
    if (!validPurpose(purpose)) return err(purposeInvalid());
    if (!(message instanceof Uint8Array)) return err(messageInvalid());

    const mac = createHmac('sha256', this.#key);
    mac.update(purpose, 'ascii');
    mac.update(Uint8Array.of(0));
    mac.update(message);
    return ok(new Uint8Array(mac.digest()));
  }

  /** A mismatched tag is a false value, not a modeled failure. */
  verify(
    purpose: string,
    message: Uint8Array,
    tag: Uint8Array,
  ): Result<boolean, Failure> {
    const expected = this.sign(purpose, message);
    if (!expected.ok) return expected;
    if (!(tag instanceof Uint8Array) || tag.byteLength !== TAG_BYTES) {
      return ok(false);
    }
    return ok(timingSafeEqual(expected.value, tag));
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
