import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';
import type { Actor } from '../provenance/index.js';

/** Feature-route leaves for H15–H17: request/reply values, cookies and Allow. */
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
/** Request headers handed to route owners, each as the list of values received. */
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
/** Cookie header → name → list of values; malformed pairs are skipped (H15). */
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
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
      value = value.slice(1, -1);
    if (!TOKEN.test(name) || !COOKIE_OCTETS.test(value)) continue;
    const list = cookies.get(name);
    if (list) list.push(value);
    else cookies.set(name, [value]);
  }
  return cookies;
}
/** Set-Cookie text; refuses control characters and unsafe __Host- cookies (H16). */
export function serializeCookie(c: CookieValue): Result<string, Failure> {
  if (
    !c ||
    typeof c.name !== 'string' ||
    typeof c.value !== 'string' ||
    !TOKEN.test(c.name) ||
    !COOKIE_OCTETS.test(c.value)
  )
    return err(invalidCookie());
  if (
    c.path !== undefined &&
    (!HEADER_VALUE.test(c.path) || c.path.includes(';'))
  )
    return err(invalidCookie());
  if (c.maxAge !== undefined && (!Number.isInteger(c.maxAge) || c.maxAge < 0))
    return err(invalidCookie());
  if (c.expires !== undefined && Number.isNaN(c.expires.getTime()))
    return err(invalidCookie());
  if (c.name.startsWith('__Host-') && (!c.secure || c.path !== '/'))
    return err(invalidCookie());
  if (c.sameSite === 'None' && !c.secure) return err(invalidCookie());
  let out = c.name + '=' + c.value;
  if (c.path !== undefined) out += '; Path=' + c.path;
  if (c.maxAge !== undefined) out += '; Max-Age=' + c.maxAge;
  if (c.expires !== undefined) out += '; Expires=' + c.expires.toUTCString();
  if (c.secure) out += '; Secure';
  if (c.httpOnly) out += '; HttpOnly';
  if (c.sameSite) out += '; SameSite=' + c.sameSite;
  return ok(out);
}
/** Allow header text for a template: registered methods plus HEAD for GET. */
export function allowFor(methods: readonly string[]): string {
  const set = new Set(methods);
  if (set.has('GET')) set.add('HEAD');
  return METHODS.filter((m) => set.has(m)).join(', ');
}
/** A validated response value; construction refuses anything off the allowlist. */
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
    if (!spec || ![200, 201, 202, 204, 303].includes(spec.status))
      return err(invalidReply());
    if (spec.status === 204 && spec.body !== undefined)
      return err(invalidReply());
    const headers = new Map<ReplyHeader, string>();
    for (const [name, value] of Object.entries(spec.headers ?? {})) {
      if (
        !(REPLY_HEADERS as readonly string[]).includes(name) ||
        typeof value !== 'string' ||
        !HEADER_VALUE.test(value)
      )
        return err(invalidReply());
      headers.set(name as ReplyHeader, value);
    }
    const cookies: string[] = [];
    for (const cookie of spec.cookies ?? []) {
      const text = serializeCookie(cookie);
      if (!text.ok) return text;
      cookies.push(text.value);
    }
    return ok(new Reply(spec.status, spec.body, headers, cookies));
  }
}
/**
 * A classified failure carrying allowlisted headers and cookies (H16), so a
 * refusal can clear a cookie or name Retry-After; the inner error keeps its
 * classification and problem projection. Construction validates like Reply.
 */
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
