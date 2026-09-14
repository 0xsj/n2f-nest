import {
  err,
  ok,
  failure,
  type Result,
  type Failure,
} from '../../../shared/errors/index.js';

/** The complete read/write allowlist (H01, H03); parsed before any Argon2 work. */
export const FORMAT = Object.freeze({
  algorithm: 'argon2id',
  version: 19,
  memory: 19456,
  passes: 2,
  parallelism: 1,
  saltBytes: 16,
  tagBytes: 32,
  maxRecordBytes: 512,
});
export type Parsed = Readonly<{ salt: Uint8Array; tag: Uint8Array }>;
export const corrupt = (): Failure =>
  failure('internal', 'stored credential record is not a supported hash', {
    type: 'identity.credential_corrupt',
  });
const B64 = /^[A-Za-z0-9+/]+$/;
const strictB64 = (s: string, length: number): Uint8Array | undefined => {
  if (!B64.test(s)) return undefined;
  const raw = Buffer.from(s, 'base64');
  if (raw.length !== length || raw.toString('base64').replace(/=+$/, '') !== s)
    return undefined;
  return new Uint8Array(raw);
};
const encodeB64 = (b: Uint8Array): string =>
  Buffer.from(b).toString('base64').replace(/=+$/, '');
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

export const parseRecord = (record: string): Result<Parsed, Failure> => {
  if (typeof record !== 'string') return err(corrupt());
  const size = bytes(record);
  if (size < 1 || size > FORMAT.maxRecordBytes) return err(corrupt());
  const fields = record.split('$');
  if (
    fields.length !== 6 ||
    fields[0] !== '' ||
    fields[1] !== FORMAT.algorithm ||
    fields[2] !== `v=${FORMAT.version}` ||
    fields[3] !==
      `m=${FORMAT.memory},t=${FORMAT.passes},p=${FORMAT.parallelism}`
  )
    return err(corrupt());
  const salt = strictB64(fields[4], FORMAT.saltBytes);
  const tag = strictB64(fields[5], FORMAT.tagBytes);
  if (!salt || !tag) return err(corrupt());
  return ok({ salt, tag });
};
export const encodeRecord = (salt: Uint8Array, tag: Uint8Array): string =>
  `$${FORMAT.algorithm}$v=${FORMAT.version}$m=${FORMAT.memory},t=${FORMAT.passes},p=${FORMAT.parallelism}$${encodeB64(salt)}$${encodeB64(tag)}`;
