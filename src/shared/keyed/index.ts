/**
 * Keyed digest: HMAC-SHA256 over a purpose label, one zero byte and a message,
 * with a root-supplied key that no presentation discloses. See CONTRACT.md
 * (K01–K05). It carries no policy about its consumers.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';
import { SecretString } from '../secret/index.js';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';

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
/** Non-empty printable ASCII without whitespace, at most 64 characters (K02). */
export function validPurpose(purpose: unknown): purpose is string {
  return (
    typeof purpose === 'string' &&
    purpose.length > 0 &&
    purpose.length <= MAX_PURPOSE &&
    /^[\x21-\x7e]+$/.test(purpose)
  );
}
export class Digest {
  readonly #key: Buffer;
  private constructor(key: Buffer) {
    this.#key = key;
    Object.freeze(this);
  }
  /** The key text is used as UTF-8 bytes; fewer than 32 bytes is refused (K01). */
  static create(key: SecretString): Result<Digest, Failure> {
    if (!(key instanceof SecretString)) return err(configuration());
    const bytes = Buffer.from(key.reveal(), 'utf8');
    if (bytes.length < MIN_KEY_BYTES) return err(configuration());
    return ok(new Digest(bytes));
  }
  sign(purpose: string, message: Uint8Array): Result<Uint8Array, Failure> {
    if (!validPurpose(purpose)) return err(purposeInvalid());
    if (!(message instanceof Uint8Array)) return err(messageInvalid());
    const mac = createHmac('sha256', this.#key);
    mac.update(purpose, 'ascii');
    mac.update(Uint8Array.of(0));
    mac.update(message);
    return ok(new Uint8Array(mac.digest()));
  }
  /** False is a value; only an invalid purpose or message is a failure (K03). */
  verify(
    purpose: string,
    message: Uint8Array,
    tag: Uint8Array,
  ): Result<boolean, Failure> {
    const expected = this.sign(purpose, message);
    if (!expected.ok) return expected;
    if (!(tag instanceof Uint8Array) || tag.byteLength !== TAG_BYTES)
      return ok(false);
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
