import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type { Entropy } from '../../../../shared/id/index.js';
import type { Digest } from '../../../../shared/keyed/index.js';

/**
 * Signed double-submit CSRF context (R04, R06): `nonce.issued_at_ms.tag`, with
 * the tag bound to the session token digest hex or the literal `anonymous`.
 */
export const ANONYMOUS = 'anonymous';
const PURPOSE = 'csrf';
const SHAPE = /^([A-Za-z0-9_-]{22})\.(\d{1,15})\.([A-Za-z0-9_-]{43})$/;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const message = (nonce: string, issuedAtMs: number, binding: string) =>
  new Uint8Array(
    Buffer.concat([
      Buffer.from(nonce, 'utf8'),
      Uint8Array.of(0),
      Buffer.from(String(issuedAtMs), 'utf8'),
      Uint8Array.of(0),
      Buffer.from(binding, 'utf8'),
    ]),
  );
export function issueCsrf(
  keyed: Digest,
  entropy: Entropy,
  nowMs: number,
  binding: string,
): Result<string, Failure> {
  const raw = new Uint8Array(16);
  try {
    entropy(raw);
  } catch (cause) {
    return err(
      failure('unavailable', 'cryptographic entropy unavailable', {
        type: 'identity.entropy_unavailable',
        cause,
      }),
    );
  }
  const nonce = b64(raw);
  const tag = keyed.sign(PURPOSE, message(nonce, nowMs, binding));
  if (!tag.ok) return tag;
  return ok(nonce + '.' + nowMs + '.' + b64(tag.value));
}
/** True only for a well-formed, unexpired token whose tag verifies under the binding. */
export function verifyCsrf(
  keyed: Digest,
  token: string,
  nowMs: number,
  ttlMs: number,
  binding: string,
): boolean {
  const m = SHAPE.exec(token);
  if (!m) return false;
  const issuedAtMs = Number(m[2]);
  if (!Number.isSafeInteger(issuedAtMs)) return false;
  if (issuedAtMs > nowMs || nowMs - issuedAtMs > ttlMs) return false;
  const tag = new Uint8Array(Buffer.from(m[3], 'base64url'));
  if (tag.byteLength !== 32 || b64(tag) !== m[3]) return false;
  const verified = keyed.verify(
    PURPOSE,
    message(m[1], issuedAtMs, binding),
    tag,
  );
  return verified.ok && verified.value;
}
