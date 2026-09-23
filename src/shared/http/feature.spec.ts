import { describe, expect, it } from 'vitest';
import {
  allowFor,
  parseCookies,
  Reply,
  serializeCookie,
} from './index.js';

describe('HTTP feature leaves', () => {
  it('parses cookies into lists and skips malformed pairs', () => {
    const cookies = parseCookies(
      'a=1; b=2; a=3; =x; novalue; c="quoted"; bad name=1; d=',
    );
    expect(cookies.get('a')).toEqual(['1', '3']);
    expect(cookies.get('b')).toEqual(['2']);
    expect(cookies.get('c')).toEqual(['quoted']);
    expect(cookies.get('d')).toEqual(['']);
    expect(cookies.has('')).toBe(false);
    expect(cookies.has('novalue')).toBe(false);
    expect(cookies.has('bad name')).toBe(false);
  });

  it('serializes cookies with prefix and control-character protections', () => {
    const base = {
      name: '__Host-n2f_session',
      value: 'abc',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax' as const,
      maxAge: 60,
    };
    expect(serializeCookie(base)).toEqual({
      ok: true,
      value:
        '__Host-n2f_session=abc; Path=/; Max-Age=60; Secure; HttpOnly; SameSite=Lax',
    });
    for (const bad of [
      { ...base, secure: false },
      { ...base, path: '/api' },
      { ...base, path: undefined },
      { ...base, name: 'bad\r\nname' },
      { ...base, value: 'a\u0000b' },
      { ...base, value: 'a;b' },
      { ...base, name: '' },
      { ...base, maxAge: -1 },
      { ...base, name: 'x=y' },
    ]) {
      const result = serializeCookie(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.type).toBe('http.invalid_cookie');
    }
  });

  it('builds replies from the status and header allowlists', () => {
    expect(Reply.create({ status: 204 }).ok).toBe(true);
    expect(
      Reply.create({
        status: 202,
        body: { accepted: true },
        headers: { 'Cache-Control': 'no-store' },
      }).ok,
    ).toBe(true);
    for (const bad of [
      { status: 200, headers: { 'X-Powered-By': 'example' } },
      { status: 404 },
      { status: 204, body: { no: 'body' } },
      { status: 200, headers: { 'Cache-Control': 'no\r\nstore' } },
    ]) {
      expect(Reply.create(bad as never).ok).toBe(false);
    }
    expect(allowFor(['POST', 'GET'])).toBe('GET, HEAD, POST');
    expect(allowFor(['DELETE'])).toBe('DELETE');
  });
});
