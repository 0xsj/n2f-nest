import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { NewPassword } from '../../domain/password.js';
import type { EnrollmentPolicy } from '../../app/command/index.js';

const configuration = (): Failure =>
  failure('invalid', 'invalid password blocklist configuration', {
    type: 'identity.blocklist_configuration',
  });
/** Simple folding: NFC then lower case; not a full Unicode caseless match (B01). */
const fold = (s: string): string => s.normalize('NFC').toLowerCase();
export interface Blocklist extends EnrollmentPolicy {
  /** Entry count for the root manifest; contents are never reported. */
  readonly size: number;
}
class FileBlocklist implements Blocklist {
  readonly #entries: ReadonlySet<string>;
  readonly size: number;
  constructor(entries: ReadonlySet<string>) {
    this.#entries = entries;
    this.size = entries.size;
    Object.freeze(this);
  }
  async checkBlocklist(
    password: NewPassword,
  ): Promise<Result<boolean, Failure>> {
    if (!(password instanceof NewPassword))
      return err(
        failure('invalid', 'password not allowed', {
          type: 'identity.password_invalid',
        }),
      );
    return ok(!this.#entries.has(fold(password.secret().reveal())));
  }
  toJSON(): { size: number } {
    return { size: this.size };
  }
  [inspect.custom](): string {
    return 'FileBlocklist(size=' + this.size + ')';
  }
}
/** Reads once at construction; a missing or empty list is a configuration fault (B02). */
export function loadBlocklist(path: string): Result<Blocklist, Failure> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return err(configuration());
  }
  const entries = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    entries.add(fold(raw.replace(/\r$/, '')));
  }
  if (entries.size === 0) return err(configuration());
  return ok(new FileBlocklist(entries));
}
