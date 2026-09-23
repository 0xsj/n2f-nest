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

const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_SALT_LENGTH = 16;

type ScryptCost = Readonly<{ N: number; r: number; p: number }>;

/**
 * New hashes use an OWASP-recommended scrypt configuration (N=2^15, r=8,
 * p=3: 32 MiB per hash, equivalent in strength to N=2^17, r=8, p=1 at a
 * quarter of the memory). The format records its parameters, so raising them
 * later needs no new format; `scrypt-v1` hashes (N=2^14, r=8, p=1) still verify.
 */
const CURRENT: ScryptCost = Object.freeze({ N: 32768, r: 8, p: 3 });
const LEGACY_V1: ScryptCost = Object.freeze({ N: 16384, r: 8, p: 1 });
const MAX_N = 1 << 20;

function cryptoFailure(message: string, cause: unknown): Failure {
  return failure('unavailable', message, {
    type: 'identity.crypto_unavailable',
    cause,
  });
}

function derivePassword(password: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      PASSWORD_KEY_LENGTH,
      { ...cost, maxmem: 256 * cost.N * cost.r },
      (error, derived) => {
        if (error) reject(error);
        else resolve(Buffer.from(derived));
      },
    );
  });
}

type ParsedHash = Readonly<{ cost: ScryptCost; salt: Buffer; digest: Buffer }>;

function decode(value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    return undefined;
  }
}

function positive(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePasswordHash(value: string): ParsedHash | undefined {
  const parts = value.split('$');
  let cost: ScryptCost | undefined;
  let salt: Buffer | undefined;
  let digest: Buffer | undefined;
  if (parts[0] === 'scrypt-v1' && parts.length === 3) {
    cost = LEGACY_V1;
    salt = decode(parts[1]);
    digest = decode(parts[2]);
  } else if (parts[0] === 'scrypt-v2' && parts.length === 6) {
    const [N, r, p] = [positive(parts[1]), positive(parts[2]), positive(parts[3])];
    // Refuse a stored cost that would exhaust memory or CPU on verification.
    if (N && r && p && N <= MAX_N && (N & (N - 1)) === 0 && r <= 32 && p <= 16) {
      cost = { N, r, p };
    }
    salt = decode(parts[4]);
    digest = decode(parts[5]);
  }
  return cost && salt?.length === PASSWORD_SALT_LENGTH && digest?.length === PASSWORD_KEY_LENGTH
    ? { cost, salt, digest }
    : undefined;
}

function format(cost: ScryptCost, salt: Buffer, digest: Buffer): string {
  return `scrypt-v2$${cost.N}$${cost.r}$${cost.p}$${salt.toString('base64url')}$${digest.toString('base64url')}`;
}

/** Node-only crypto adapter; the application only sees its narrow ports. */
export class NodePasswordCodec implements PasswordHasher, PasswordVerifier {
  #decoy?: Promise<ParsedHash>;

  constructor(private readonly cost: ScryptCost = CURRENT) {}

  async hash(password: SecretString): Promise<Result<SecretString, Failure>> {
    try {
      const salt = randomBytes(PASSWORD_SALT_LENGTH);
      const digest = await derivePassword(password.reveal(), salt, this.cost);
      return ok(new Secret(format(this.cost, salt, digest)));
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
    return this.#compare(password, parsed);
  }

  async verifyDecoy(password: SecretString): Promise<Result<false, Failure>> {
    try {
      // A random, never-disclosed hash at the current cost matches no password.
      this.#decoy ??= (async () => {
        const salt = randomBytes(PASSWORD_SALT_LENGTH);
        const digest = await derivePassword(randomBytes(32).toString('base64url'), salt, this.cost);
        return { cost: this.cost, salt, digest };
      })();
      const compared = await this.#compare(password, await this.#decoy);
      return compared.ok ? ok(false) : compared;
    } catch (cause) {
      this.#decoy = undefined;
      return err(cryptoFailure('password verification is unavailable', cause));
    }
  }

  async #compare(password: SecretString, parsed: ParsedHash): Promise<Result<boolean, Failure>> {
    try {
      const digest = await derivePassword(password.reveal(), parsed.salt, parsed.cost);
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
