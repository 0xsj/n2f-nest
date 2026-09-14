import {
  err,
  ok,
  failure,
  type Result,
  type Failure,
} from '../../../shared/errors/index.js';
import { parse, type ID } from '../../../shared/id/index.js';
import { SecretString } from '../../../shared/secret/index.js';
import { Email } from './email.js';
import { isOptionalTime, isRecord, isTime, isVersion } from './bounds.js';
export type CredentialSnapshot = {
  principalId: ID;
  email: Email;
  passwordHash: SecretString;
  verifiedAtMs?: number;
  passwordVersion: number;
  createdAtMs: number;
  changedAtMs: number;
};
const invalid = () =>
  failure('invalid', 'invalid credential', {
    type: 'identity.credential_invalid',
  });
const corrupt = () =>
  failure('internal', 'corrupt credential record', {
    type: 'identity.credential_corrupt',
  });
const hashBytes = (s: string) => new TextEncoder().encode(s).length;
export class PasswordCredential {
  readonly #state: Readonly<CredentialSnapshot>;
  private constructor(state: CredentialSnapshot) {
    this.#state = Object.freeze({ ...state });
  }
  static restore(s: CredentialSnapshot): Result<PasswordCredential, Failure> {
    if (!isRecord(s)) return err(invalid());
    const id = parse(s.principalId);
    if (
      !id.ok ||
      !Email.valid(s.email) ||
      !(s.passwordHash instanceof SecretString) ||
      !isVersion(s.passwordVersion) ||
      !isTime(s.createdAtMs) ||
      !isTime(s.changedAtMs) ||
      s.changedAtMs < s.createdAtMs ||
      !isOptionalTime(s.verifiedAtMs) ||
      (s.verifiedAtMs !== undefined && s.verifiedAtMs < s.createdAtMs)
    )
      return err(invalid());
    const hash = s.passwordHash.reveal();
    if (typeof hash !== 'string' || hash.length === 0 || hashBytes(hash) > 512)
      return err(corrupt());
    return ok(
      new PasswordCredential({
        principalId: id.value,
        email: s.email,
        passwordHash: s.passwordHash,
        passwordVersion: s.passwordVersion,
        createdAtMs: s.createdAtMs,
        changedAtMs: s.changedAtMs,
        ...(s.verifiedAtMs === undefined
          ? {}
          : { verifiedAtMs: s.verifiedAtMs }),
      }),
    );
  }
  snapshot(): CredentialSnapshot {
    return { ...this.#state };
  }
}
