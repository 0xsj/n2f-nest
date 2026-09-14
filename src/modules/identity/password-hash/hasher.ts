import { argon2, timingSafeEqual } from 'node:crypto';
import {
  err,
  ok,
  failure,
  type Result,
  type Failure,
} from '../../../shared/errors/index.js';
import { SecretString } from '../../../shared/secret/index.js';
import type { Entropy } from '../../../shared/id/index.js';
import { NewPassword, PasswordInput } from '../domain/password.js';
import {
  Admission,
  configuration,
  validLimits,
  type Limits,
} from './admission.js';
import { FORMAT, corrupt, encodeRecord, parseRecord } from './phc.js';

export type Outcome = 'match' | 'mismatch';
export type Options = { signal?: AbortSignal };
/** The CPU-bound derivation; replaced only by admission tests. */
export type Derive = (
  message: Uint8Array,
  salt: Uint8Array,
) => Promise<Uint8Array>;

const argon2id: Derive = (message, salt) =>
  new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message,
        nonce: salt,
        parallelism: FORMAT.parallelism,
        tagLength: FORMAT.tagBytes,
        memory: FORMAT.memory,
        passes: FORMAT.passes,
      },
      (e, key) => (e ? reject(e) : resolve(new Uint8Array(key))),
    );
  });
/** Fixed record so an unknown login costs comparable work (H05). */
const DUMMY_RECORD =
  '$argon2id$v=19$m=19456,t=2,p=1$gIGCg4SFhoeIiYqLjI2Ojw$hCpNSDRlggIY1L1+l6kN4tcjdR+eIOW4qSmc8vLLUXg';
const invalidPassword = () =>
  failure('invalid', 'invalid password', { type: 'identity.password_invalid' });
const entropyUnavailable = (cause: unknown) =>
  failure('unavailable', 'cryptographic entropy unavailable', {
    type: 'identity.entropy_unavailable',
    cause,
  });
const hashFailed = (cause: unknown) =>
  failure('internal', 'password hashing failed', {
    type: 'identity.hash_failed',
    cause,
  });
const encoder = new TextEncoder();
/** Bound in the class's static block so the constructor stays private. */
let make: (
  derive: Derive,
  entropy: Entropy,
  limits: Limits,
) => Result<PasswordHasher, Failure>;

export class PasswordHasher {
  readonly #derive: Derive;
  readonly #entropy: Entropy;
  readonly #admission: Admission;
  private constructor(derive: Derive, entropy: Entropy, limits: Limits) {
    this.#derive = derive;
    this.#entropy = entropy;
    this.#admission = new Admission(limits);
    Object.freeze(this);
  }
  static {
    make = (derive, entropy, limits) =>
      typeof entropy !== 'function' || !validLimits(limits)
        ? err(configuration())
        : ok(new PasswordHasher(derive, entropy, limits));
  }
  static create(
    entropy: Entropy,
    limits: Limits,
  ): Result<PasswordHasher, Failure> {
    return make(argon2id, entropy, limits);
  }
  async hash(
    password: NewPassword,
    options: Options = {},
  ): Promise<Result<SecretString, Failure>> {
    if (!(password instanceof NewPassword)) return err(invalidPassword());
    const salt = new Uint8Array(FORMAT.saltBytes);
    try {
      this.#entropy(salt);
    } catch (cause) {
      return err(entropyUnavailable(cause));
    }
    const tag = await this.#work(
      encoder.encode(password.secret().reveal()),
      salt,
      options.signal,
    );
    return tag.ok
      ? ok(new SecretString(encodeRecord(salt, tag.value)))
      : err(tag.error);
  }
  async verify(
    input: PasswordInput,
    record: SecretString,
    options: Options = {},
  ): Promise<Result<Outcome, Failure>> {
    if (!(input instanceof PasswordInput)) return err(invalidPassword());
    if (!(record instanceof SecretString)) return err(corrupt());
    const parsed = parseRecord(record.reveal());
    if (!parsed.ok) return err(parsed.error);
    const tag = await this.#work(
      encoder.encode(input.secret().reveal()),
      parsed.value.salt,
      options.signal,
    );
    if (!tag.ok) return err(tag.error);
    return ok(
      timingSafeEqual(tag.value, parsed.value.tag) ? 'match' : 'mismatch',
    );
  }
  async verifyAbsent(
    input: PasswordInput,
    options: Options = {},
  ): Promise<Result<Outcome, Failure>> {
    if (!(input instanceof PasswordInput)) return err(invalidPassword());
    const parsed = parseRecord(DUMMY_RECORD);
    if (!parsed.ok) return err(parsed.error);
    const tag = await this.#work(
      encoder.encode(input.secret().reveal()),
      parsed.value.salt,
      options.signal,
    );
    if (!tag.ok) return err(tag.error);
    timingSafeEqual(tag.value, parsed.value.tag);
    return ok('mismatch');
  }
  needsRehash(record: SecretString): Result<boolean, Failure> {
    if (!(record instanceof SecretString)) return err(corrupt());
    const parsed = parseRecord(record.reveal());
    return parsed.ok ? ok(false) : err(parsed.error);
  }
  /** Admission, then work that runs to completion once admitted (H06, H07). */
  async #work(
    message: Uint8Array,
    salt: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Result<Uint8Array, Failure>> {
    const admitted = await this.#admission.acquire(signal);
    if (!admitted.ok) return err(admitted.error);
    try {
      return ok(await this.#derive(message, salt));
    } catch (cause) {
      return err(hashFailed(cause));
    } finally {
      admitted.value();
    }
  }
}
/** Not exported from the package index: admission tests inject blocking work. */
export const createHasher = (
  derive: Derive,
  entropy: Entropy,
  limits: Limits,
) => make(derive, entropy, limits);
