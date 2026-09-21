import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';
import type { Actor } from '../provenance/index.js';

export type Method =
  | 'GET'
  | 'HEAD'
  | 'POST'
  | 'PUT'
  | 'DELETE'
  | 'CONNECT'
  | 'OPTIONS'
  | 'TRACE'
  | 'PATCH';

export const METHODS: readonly Method[] = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'DELETE',
  'CONNECT',
  'OPTIONS',
  'TRACE',
  'PATCH',
];

export const SELECTED_HEADERS = [
  'origin',
  'content-type',
  'x-csrf-token',
  'sec-websocket-protocol',
] as const;
export type SelectedHeader = (typeof SELECTED_HEADERS)[number];

export interface FeatureRequest {
  readonly method: string;
  readonly template: string;
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<SelectedHeader, readonly string[]>>;
  readonly cookies: ReadonlyMap<string, readonly string[]>;
  readonly source: string;
  readonly query: string;
  readonly admitted?: unknown;
}

export type Admission =
  | { readonly kind: 'anonymous' }
  | {
      readonly kind: 'authenticated';
      readonly initiator: Actor;
      readonly tenant?: string;
      readonly admitted?: unknown;
    }
  | {
      readonly kind: 'refused';
      readonly error: unknown;
      readonly retryAfterSeconds?: number;
    };

export type ReplyStatus = 200 | 201 | 202 | 204 | 303;

export const REPLY_HEADERS = [
  'Cache-Control',
  'Allow',
  'WWW-Authenticate',
  'Retry-After',
  'Location',
] as const;
export type ReplyHeader = (typeof REPLY_HEADERS)[number];

export interface CookieValue {
  readonly name: string;
  readonly value: string;
  readonly path?: string;
  readonly maxAge?: number;
  readonly expires?: Date;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface ReplySpec {
  readonly status: ReplyStatus;
  readonly body?: unknown;
  readonly headers?: Partial<Readonly<Record<ReplyHeader, string>>>;
  readonly cookies?: readonly CookieValue[];
}

const invalidCookie = (): Failure =>
  failure('internal', 'invalid cookie value', { type: 'http.invalid_cookie' });
const invalidReply = (): Failure =>
  failure('internal', 'invalid reply value', { type: 'http.invalid_reply' });
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_OCTETS = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;
const HEADER_VALUE = /^[\x20-\x7e]*$/;

export function parseCookies(
  header: string | undefined,
): ReadonlyMap<string, readonly string[]> {
  const cookies = new Map<string, string[]>();
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const at = pair.indexOf('=');
    if (at < 0) continue;
    const name = pair.slice(0, at).trim();
    let value = pair.slice(at + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (!TOKEN.test(name) || !COOKIE_OCTETS.test(value)) continue;
    const values = cookies.get(name);
    if (values) values.push(value);
    else cookies.set(name, [value]);
  }
  return cookies;
}

export function serializeCookie(cookie: CookieValue): Result<string, Failure> {
  if (
    !cookie ||
    typeof cookie.name !== 'string' ||
    typeof cookie.value !== 'string' ||
    !TOKEN.test(cookie.name) ||
    !COOKIE_OCTETS.test(cookie.value)
  ) {
    return err(invalidCookie());
  }
  if (
    cookie.path !== undefined &&
    (!HEADER_VALUE.test(cookie.path) || cookie.path.includes(';'))
  ) {
    return err(invalidCookie());
  }
  if (
    cookie.maxAge !== undefined &&
    (!Number.isInteger(cookie.maxAge) || cookie.maxAge < 0)
  ) {
    return err(invalidCookie());
  }
  if (
    cookie.expires !== undefined &&
    Number.isNaN(cookie.expires.getTime())
  ) {
    return err(invalidCookie());
  }
  if (cookie.name.startsWith('__Host-') && (!cookie.secure || cookie.path !== '/')) {
    return err(invalidCookie());
  }
  if (cookie.sameSite === 'None' && !cookie.secure) return err(invalidCookie());

  let output = cookie.name + '=' + cookie.value;
  if (cookie.path !== undefined) output += '; Path=' + cookie.path;
  if (cookie.maxAge !== undefined) output += '; Max-Age=' + cookie.maxAge;
  if (cookie.expires !== undefined) {
    output += '; Expires=' + cookie.expires.toUTCString();
  }
  if (cookie.secure) output += '; Secure';
  if (cookie.httpOnly) output += '; HttpOnly';
  if (cookie.sameSite) output += '; SameSite=' + cookie.sameSite;
  return ok(output);
}

export function allowFor(methods: readonly string[]): string {
  const set = new Set(methods);
  if (set.has('GET')) set.add('HEAD');
  return METHODS.filter((method) => set.has(method)).join(', ');
}

export class Reply {
  readonly status: ReplyStatus;
  readonly body: unknown;
  readonly headers: ReadonlyMap<ReplyHeader, string>;
  readonly cookies: readonly string[];

  private constructor(
    status: ReplyStatus,
    body: unknown,
    headers: ReadonlyMap<ReplyHeader, string>,
    cookies: readonly string[],
  ) {
    this.status = status;
    this.body = body;
    this.headers = headers;
    this.cookies = cookies;
    Object.freeze(this);
  }

  static create(spec: ReplySpec): Result<Reply, Failure> {
    if (!spec || ![200, 201, 202, 204, 303].includes(spec.status)) {
      return err(invalidReply());
    }
    if (spec.status === 204 && spec.body !== undefined) {
      return err(invalidReply());
    }
    const headers = new Map<ReplyHeader, string>();
    for (const [name, value] of Object.entries(spec.headers ?? {})) {
      if (
        !(REPLY_HEADERS as readonly string[]).includes(name) ||
        typeof value !== 'string' ||
        !HEADER_VALUE.test(value)
      ) {
        return err(invalidReply());
      }
      headers.set(name as ReplyHeader, value);
    }
    const cookies: string[] = [];
    for (const cookie of spec.cookies ?? []) {
      const serialized = serializeCookie(cookie);
      if (!serialized.ok) return serialized;
      cookies.push(serialized.value);
    }
    return ok(new Reply(spec.status, spec.body, headers, cookies));
  }
}

export class Refuse {
  readonly error: unknown;
  readonly headers: ReadonlyMap<ReplyHeader, string>;
  readonly cookies: readonly string[];

  private constructor(
    error: unknown,
    headers: ReadonlyMap<ReplyHeader, string>,
    cookies: readonly string[],
  ) {
    this.error = error;
    this.headers = headers;
    this.cookies = cookies;
    Object.freeze(this);
  }

  static create(
    error: unknown,
    spec: Pick<ReplySpec, 'headers' | 'cookies'> = {},
  ): Result<Refuse, Failure> {
    if (error === undefined || error === null) return err(invalidReply());
    const reply = Reply.create({ status: 204, ...spec });
    if (!reply.ok) return reply;
    return ok(new Refuse(error, reply.value.headers, reply.value.cookies));
  }
}
