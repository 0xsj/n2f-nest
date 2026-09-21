import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import { SecretString as Secret } from '../../../../shared/secret/index.js';
import type {
  PasswordHasher,
  PasswordVerifier,
  SessionTokenIssuer,
  SessionTokenMaterial,
  VerificationTokenIssuer,
  VerificationTokenMaterial,
  VerificationTokenVerifier,
} from '../../app/ports/index.js';

const PASSWORD_PREFIX = 'scrypt-v1';
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_SALT_LENGTH = 16;

function cryptoFailure(message: string, cause: unknown): Failure {
  return failure('unavailable', message, {
    type: 'identity.crypto_unavailable',
    cause,
  });
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      PASSWORD_KEY_LENGTH,
      { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 },
      (error, derived) => {
        if (error) reject(error);
        else resolve(Buffer.from(derived));
      },
    );
  });
}

function parsePasswordHash(value: string):
  | { readonly salt: Buffer; readonly digest: Buffer }
  | undefined {
  const [prefix, saltValue, digestValue] = value.split('$');
  if (prefix !== PASSWORD_PREFIX || !saltValue || !digestValue) return undefined;
  try {
    const salt = Buffer.from(saltValue, 'base64url');
    const digest = Buffer.from(digestValue, 'base64url');
    return salt.length === PASSWORD_SALT_LENGTH && digest.length === PASSWORD_KEY_LENGTH
      ? { salt, digest }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Node-only crypto adapter; the application only sees its narrow ports. */
export class NodePasswordCodec implements PasswordHasher, PasswordVerifier {
  async hash(password: SecretString): Promise<Result<SecretString, Failure>> {
    try {
      const salt = randomBytes(PASSWORD_SALT_LENGTH);
      const digest = await derivePassword(password.reveal(), salt);
      return ok(new Secret(`${PASSWORD_PREFIX}$${salt.toString('base64url')}$${digest.toString('base64url')}`));
    } catch (cause) {
      return err(cryptoFailure('password hashing is unavailable', cause));
    }
  }

  async verify(
    password: SecretString,
    passwordHash: SecretString,
  ): Promise<Result<boolean, Failure>> {
    const parsed = parsePasswordHash(passwordHash.reveal());
    if (!parsed) return ok(false);
    try {
      const digest = await derivePassword(password.reveal(), parsed.salt);
      return ok(timingSafeEqual(digest, parsed.digest));
    } catch (cause) {
      return err(cryptoFailure('password verification is unavailable', cause));
    }
  }
}

export function digestToken(token: SecretString): SecretString {
  return new Secret(createHash('sha256').update(token.reveal(), 'utf8').digest('hex'));
}

/** Opaque bearer-token adapter shared by verification and session flows. */
export class NodeTokenCodec
  implements
    SessionTokenIssuer,
    VerificationTokenIssuer,
    VerificationTokenVerifier
{
  async issue(): Promise<Result<SessionTokenMaterial & VerificationTokenMaterial, Failure>> {
    try {
      const token = new Secret(randomBytes(32).toString('base64url'));
      return ok({ token, digest: digestToken(token) });
    } catch (cause) {
      return err(cryptoFailure('token generation is unavailable', cause));
    }
  }

  async verify(
    token: SecretString,
    digest: SecretString,
  ): Promise<Result<boolean, Failure>> {
    const expected = Buffer.from(digest.reveal(), 'utf8');
    const actual = Buffer.from(digestToken(token).reveal(), 'utf8');
    return ok(
      expected.length === actual.length && timingSafeEqual(expected, actual),
    );
  }
}
