/** Versioned bounded envelope; domains own message meanings. */
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';

export type Message = {
  v: 1;
  id: string;
  type: string;
  payload: Record<string, unknown>;
};

const invalid = () =>
  failure('invalid', 'invalid socket message', { type: 'socket.invalid' });

export function decode(raw: Uint8Array): Result<Message, Failure> {
  if (raw.byteLength > 65536) return err(invalid());
  try {
    const message: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(raw),
    );
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message)
    ) {
      return err(invalid());
    }
    const value = message as Record<string, unknown>;
    if (
      Object.keys(value).length !== 4 ||
      value.v !== 1 ||
      typeof value.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(value.id) ||
      typeof value.type !== 'string' ||
      !/^[a-z0-9_.]{1,64}$/.test(value.type) ||
      !value.payload ||
      typeof value.payload !== 'object' ||
      Array.isArray(value.payload)
    ) {
      return err(invalid());
    }
    return ok(value as Message);
  } catch {
    return err(invalid());
  }
}

export function encode(message: Message): Result<Uint8Array, Failure> {
  try {
    const raw = Buffer.from(JSON.stringify(message));
    const valid = decode(raw);
    return valid.ok ? ok(raw) : valid;
  } catch {
    return err(invalid());
  }
}
