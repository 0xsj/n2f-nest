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
  failure('invalid', 'invalid email', { type: 'identity.email_invalid' });
const local =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const label = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const canonical = (input: string): string | undefined => {
  if (typeof input !== 'string' || !isWellFormed(input)) return undefined;
  // ASCII-only baseline: string length is the byte length.
  if (input.length < 1 || input.length > 254 || !/^[\x21-\x7e]+$/.test(input))
    return undefined;
  const at = input.indexOf('@');
  if (at < 0 || input.indexOf('@', at + 1) >= 0) return undefined;
  const user = input.slice(0, at),
    domain = input.slice(at + 1);
  if (user.length > 64 || !local.test(user)) return undefined;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((l) => label.test(l)))
    return undefined;
  return input.toLowerCase();
};
/** Canonical login identifier; ordinary presentation redacts, reveal is explicit. */
export class Email extends SecretString {
  private constructor(value: string) {
    super(value);
  }
  static parse(input: string): Result<Email, Failure> {
    const value = canonical(input);
    return value === undefined ? err(invalid()) : ok(new Email(value));
  }
  /** True only for an instance whose text is still canonical. */
  static valid(value: unknown): value is Email {
    return (
      value instanceof Email &&
      typeof value.reveal() === 'string' &&
      canonical(value.reveal()) === value.reveal()
    );
  }
}
