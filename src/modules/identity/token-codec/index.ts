/**
 * Identity-owned opaque token issuance and digesting; see CONTRACT.md (T01–T08).
 * Storage, cookies and comparison against stored digests belong elsewhere.
 */
import { createHash } from 'node:crypto';
import {
  err,
  ok,
  failure,
  type Result,
  type Failure,
} from '../../../shared/errors/index.js';
import { SecretString } from '../../../shared/secret/index.js';
import type { Entropy } from '../../../shared/id/index.js';
import {
  TokenDigest,
  isTokenPurpose,
  type TokenPurpose,
} from '../domain/token.js';

export type Issued = Readonly<{ secret: SecretString; digest: TokenDigest }>;
const TOKEN_BYTES = 32;
const SECRET_LENGTH = 43;
const CANONICAL = /^[A-Za-z0-9_-]{43}$/;
const invalid = () =>
  failure('invalid', 'invalid token', { type: 'identity.token_invalid' });
const digestOf = (purpose: TokenPurpose, raw: Uint8Array): Uint8Array =>
  new Uint8Array(
    createHash('sha256')
      .update(purpose, 'utf8')
      .update(Uint8Array.of(0))
      .update(raw)
      .digest(),
  );
/** Strict canonical base64url (T02): fixed length, alphabet, size and re-encode equality. */
const decodeSecret = (secret: string): Uint8Array | undefined => {
  if (
    typeof secret !== 'string' ||
    secret.length !== SECRET_LENGTH ||
    !CANONICAL.test(secret)
  )
    return undefined;
  const raw = Buffer.from(secret, 'base64url');
  if (raw.length !== TOKEN_BYTES || raw.toString('base64url') !== secret)
    return undefined;
  return new Uint8Array(raw);
};

export class TokenCodec {
  readonly #entropy: Entropy;
  private constructor(entropy: Entropy) {
    this.#entropy = entropy;
    Object.freeze(this);
  }
  static create(entropy: Entropy): Result<TokenCodec, Failure> {
    if (typeof entropy !== 'function')
      return err(
        failure('invalid', 'invalid token codec configuration', {
          type: 'identity.token_codec_configuration',
        }),
      );
    return ok(new TokenCodec(entropy));
  }
  issue(purpose: TokenPurpose): Result<Issued, Failure> {
    if (!isTokenPurpose(purpose)) return err(invalid());
    const raw = new Uint8Array(TOKEN_BYTES);
    try {
      this.#entropy(raw);
    } catch (cause) {
      return err(
        failure('unavailable', 'cryptographic entropy unavailable', {
          type: 'identity.entropy_unavailable',
          cause,
        }),
      );
    }
    const digest = TokenDigest.parse(purpose, digestOf(purpose, raw));
    if (!digest.ok) return err(digest.error);
    return ok(
      Object.freeze({
        secret: new SecretString(Buffer.from(raw).toString('base64url')),
        digest: digest.value,
      }),
    );
  }
  digest(
    purpose: TokenPurpose,
    secret: SecretString,
  ): Result<TokenDigest, Failure> {
    if (!isTokenPurpose(purpose) || !(secret instanceof SecretString))
      return err(invalid());
    const raw = decodeSecret(secret.reveal());
    if (!raw) return err(invalid());
    return TokenDigest.parse(purpose, digestOf(purpose, raw));
  }
}
