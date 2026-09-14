import { All, Controller, Module, Req, Res } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Request, Response } from 'express';
import { createServer, type Server as NodeServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeClock, SystemClock } from '../../../../shared/clock/index.js';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type { Envelope } from '../../../../shared/events/index.js';
import { Server, type Config } from '../../../../shared/http/nest/server.js';
import type {
  Observation,
  Observer,
} from '../../../../shared/http/nest/observer.js';
import type { Completion } from '../../../../shared/http/lifecycle.js';
import { V7, type ID } from '../../../../shared/id/index.js';
import { Digest } from '../../../../shared/keyed/index.js';
import {
  create as createLogger,
  type Runtime,
} from '../../../../shared/logger/index.js';
import {
  Factory,
  actor,
  operation,
  type Scope,
} from '../../../../shared/provenance/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import {
  ChangePassword,
  DEFAULT_CONFIG,
  Login,
  Logout,
  LogoutAll,
  Register,
  RequestReset,
  RequestVerification,
  ResetPassword,
  VerifyEmail,
  WebSocketTicket,
  type Admission,
  type ChallengeRecord,
  type ChangePasswordRecord,
  type CredentialRecord,
  type IssueChallengeRecord,
  type LoginRecord,
  type Ports,
  type RegisterRecord,
  type ResetPasswordRecord,
  type Store,
  type UpgradeTicketAdmission,
  type UpgradeTicketRecord,
  type VerifyRecord,
} from '../../app/command/index.js';
import {
  Authenticate,
  type Resolution,
  type SessionResolver,
} from '../../app/query/index.js';
import type { ChallengeSnapshot } from '../../domain/challenge.js';
import type { CredentialSnapshot } from '../../domain/credential.js';
import type { Email } from '../../domain/email.js';
import type { Snapshot } from '../../domain/principal.js';
import { Session, type SessionSnapshot } from '../../domain/session.js';
import type { TokenDigest, TokenPurpose } from '../../domain/token.js';
import { UpgradeTicket } from '../../domain/upgrade-ticket.js';
import { PasswordHasher } from '../../password-hash/index.js';
import { TokenCodec } from '../../token-codec/index.js';
import { createTransport, type TransportConfig } from './index.js';

const value = <T>(r: Result<T, Failure>): T => {
  if (!r.ok) throw new Error('expected success: ' + r.error.type);
  return r.value;
};
const hex = (d: TokenDigest) => Buffer.from(d.bytes()).toString('hex');
const PASSWORD = 'correct horse battery SENTINEL';
const ORIGIN = 'http://app.test';

/** In-memory store standing in for the stage 5 adapter; no locks, one process. */
class MemoryStore implements Store, SessionResolver {
  principals = new Map<ID, Snapshot>();
  credentials = new Map<ID, CredentialSnapshot>();
  epochs = new Map<ID, number>();
  sessions = new Map<string, SessionSnapshot>();
  challenges: ChallengeSnapshot[] = [];
  tickets = new Map<string, UpgradeTicketRecord['ticket']>();
  resolveCalls = 0;
  fail?: Failure;
  #gate<T>(): Result<T, Failure> | undefined {
    return this.fail ? err(this.fail) : undefined;
  }
  async register(r: RegisterRecord) {
    const gate = this.#gate<'created' | 'duplicate_email'>();
    if (gate) return gate;
    for (const c of this.credentials.values())
      if (c.email.reveal() === r.credential.email.reveal())
        return ok('duplicate_email' as const);
    this.principals.set(r.principal.id, r.principal);
    this.credentials.set(r.principal.id, r.credential);
    this.epochs.set(r.principal.id, r.authEpoch);
    this.challenges.push(r.challenge);
    return ok('created' as const);
  }
  #record(id: ID): CredentialRecord | undefined {
    const principal = this.principals.get(id),
      credential = this.credentials.get(id);
    return principal && credential
      ? { principal, credential, authEpoch: this.epochs.get(id)! }
      : undefined;
  }
  async findByEmail(email: Email) {
    const gate = this.#gate<CredentialRecord | undefined>();
    if (gate) return gate;
    for (const c of this.credentials.values())
      if (c.email.reveal() === email.reveal())
        return ok(this.#record(c.principalId));
    return ok(undefined);
  }
  async findByPrincipal(id: ID) {
    const gate = this.#gate<CredentialRecord | undefined>();
    if (gate) return gate;
    return ok(this.#record(id));
  }
  async commitLogin(r: LoginRecord) {
    const gate = this.#gate<'committed' | 'stale'>();
    if (gate) return gate;
    const rec = this.#record(r.session.principalId);
    if (
      !rec ||
      rec.principal.status !== 'active' ||
      rec.credential.verifiedAtMs === undefined ||
      rec.credential.passwordVersion !== r.expectedPasswordVersion ||
      rec.authEpoch !== r.expectedAuthEpoch
    )
      return ok('stale' as const);
    this.sessions.set(hex(r.session.tokenDigest), r.session);
    return ok('committed' as const);
  }
  async issueUpgradeTicket(r: UpgradeTicketRecord) {
    const gate = this.#gate<'committed' | 'stale'>();
    if (gate) return gate;
    const session = [...this.sessions.values()].find((s) => s.id === r.ticket.sessionId);
    const rec = session ? this.#record(session.principalId) : undefined;
    if (!session || !rec || session.id !== r.ticket.sessionId || session.authEpoch !== r.expectedAuthEpoch || rec.authEpoch !== r.expectedAuthEpoch || rec.principal.status !== 'active' || rec.credential.verifiedAtMs === undefined) return ok('stale' as const);
    const restored = Session.restore(session);
    if (!restored.ok || !restored.value.check(r.ticket.issuedAtMs).ok) return ok('stale' as const);
    this.tickets.set(hex(r.ticket.tokenDigest), r.ticket);
    return ok('committed' as const);
  }
  async consumeUpgradeTicket(digest: TokenDigest, nowMs: number): Promise<Result<UpgradeTicketAdmission | undefined, Failure>> {
    const gate = this.#gate<UpgradeTicketAdmission | undefined>();
    if (gate) return gate;
    const ticket = this.tickets.get(hex(digest));
    if (!ticket) return ok(undefined);
    const session = [...this.sessions.values()].find((s) => s.id === ticket.sessionId);
    const rec = session ? this.#record(session.principalId) : undefined;
    if (!session || !rec || rec.principal.status !== 'active' || rec.credential.verifiedAtMs === undefined || session.authEpoch !== rec.authEpoch) return ok(undefined);
    const restored = UpgradeTicket.restore(ticket);
    if (!restored.ok) return restored;
    const consumed = restored.value.consume(nowMs);
    if (!consumed.ok) return ok(undefined);
    this.tickets.set(hex(digest), consumed.value.snapshot());
    return ok({ principalId: session.principalId, sessionId: session.id, authEpoch: session.authEpoch });
  }
  async resolve(digest: TokenDigest, nowMs: number, idleTtlMs: number) {
    this.resolveCalls++;
    const gate = this.#gate<Resolution>();
    if (gate) return gate;
    const key = hex(digest);
    const snapshot = this.sessions.get(key);
    if (!snapshot) return ok({ outcome: 'absent' } as const);
    const session = value(Session.restore(snapshot));
    if (!session.check(nowMs).ok) return ok({ outcome: 'rejected' } as const);
    const rec = this.#record(snapshot.principalId);
    if (
      !rec ||
      rec.principal.status !== 'active' ||
      rec.credential.verifiedAtMs === undefined ||
      rec.authEpoch !== snapshot.authEpoch
    )
      return ok({ outcome: 'rejected' } as const);
    const touched = session.touch(nowMs, idleTtlMs);
    if (!touched.ok) return ok({ outcome: 'rejected' } as const);
    this.sessions.set(key, touched.value.snapshot());
    return ok({
      outcome: 'admitted',
      principalId: snapshot.principalId,
      sessionId: snapshot.id,
      authEpoch: snapshot.authEpoch,
    } as const);
  }
  async revokeSession(
    sessionId: ID,
    principalId: ID,
    nowMs: number,
    _e: Envelope,
  ) {
    const gate = this.#gate<'revoked' | 'already_inactive' | 'absent'>();
    if (gate) return gate;
    for (const [key, s] of this.sessions)
      if (s.id === sessionId && s.principalId === principalId) {
        if (s.revokedAtMs !== undefined) return ok('already_inactive' as const);
        this.sessions.set(key, { ...s, revokedAtMs: nowMs });
        return ok('revoked' as const);
      }
    return ok('absent' as const);
  }
  async revokeAll(
    principalId: ID,
    expected: number,
    _now: number,
    _e: Envelope,
  ) {
    const gate = this.#gate<'committed' | 'stale'>();
    if (gate) return gate;
    if (this.epochs.get(principalId) !== expected) return ok('stale' as const);
    this.epochs.set(principalId, expected + 1);
    return ok('committed' as const);
  }
  async findByDigest(purpose: TokenPurpose, digest: TokenDigest) {
    const gate = this.#gate<ChallengeRecord | undefined>();
    if (gate) return gate;
    const c = this.challenges.find(
      (x) =>
        x.tokenDigest.purpose() === purpose &&
        hex(x.tokenDigest) === hex(digest),
    );
    if (!c) return ok(undefined);
    const rec = this.#record(c.principalId)!;
    return ok({
      challenge: c,
      credential: rec.credential,
      principalStatus: rec.principal.status,
      authEpoch: rec.authEpoch,
    });
  }
  async issueChallenge(r: IssueChallengeRecord) {
    const gate = this.#gate<'issued' | 'stale'>();
    if (gate) return gate;
    const cred = this.credentials.get(r.challenge.principalId);
    if (!cred || cred.passwordVersion !== r.expectedPasswordVersion)
      return ok('stale' as const);
    this.challenges = this.challenges.map((c) =>
      c.principalId === r.challenge.principalId &&
      c.tokenDigest.purpose() === r.challenge.tokenDigest.purpose() &&
      c.consumedAtMs === undefined &&
      c.invalidatedAtMs === undefined
        ? { ...c, invalidatedAtMs: r.challenge.issuedAtMs }
        : c,
    );
    this.challenges.push(r.challenge);
    return ok('issued' as const);
  }
  #consume(
    id: ID,
    principalId: ID,
    consumedAtMs: number,
    purpose: TokenPurpose,
  ) {
    const i = this.challenges.findIndex(
      (c) =>
        c.id === id &&
        c.principalId === principalId &&
        c.tokenDigest.purpose() === purpose &&
        c.consumedAtMs === undefined &&
        c.invalidatedAtMs === undefined &&
        c.issuedAtMs <= consumedAtMs &&
        consumedAtMs < c.expiresAtMs,
    );
    if (i < 0) return false;
    this.challenges[i] = { ...this.challenges[i], consumedAtMs };
    return true;
  }
  async verifyEmail(r: VerifyRecord) {
    const gate = this.#gate<'committed' | 'stale'>();
    if (gate) return gate;
    const cred = this.credentials.get(r.principalId);
    if (!cred || cred.passwordVersion !== r.expectedPasswordVersion)
      return ok('stale' as const);
    if (
      !this.#consume(
        r.challengeId,
        r.principalId,
        r.consumedAtMs,
        'email_verification',
      )
    )
      return ok('stale' as const);
    this.credentials.set(r.principalId, {
      ...cred,
      verifiedAtMs: cred.verifiedAtMs ?? r.consumedAtMs,
    });
    return ok('committed' as const);
  }
  async changePassword(r: ChangePasswordRecord) {
    const gate = this.#gate<'committed' | 'stale'>();
    if (gate) return gate;
    const cred = this.credentials.get(r.principalId);
    if (
      !cred ||
      cred.passwordVersion !== r.expectedPasswordVersion ||
      this.epochs.get(r.principalId) !== r.expectedAuthEpoch
    )
      return ok('stale' as const);
    this.credentials.set(r.principalId, {
      ...cred,
      passwordHash: r.passwordHash,
      passwordVersion: cred.passwordVersion + 1,
      changedAtMs: r.changedAtMs,
    });
    this.epochs.set(r.principalId, r.expectedAuthEpoch + 1);
    return ok('committed' as const);
  }
  async resetPassword(r: ResetPasswordRecord) {
    const gate = this.#gate<'committed' | 'stale'>();
    if (gate) return gate;
    const cred = this.credentials.get(r.principalId);
    if (
      !cred ||
      cred.passwordVersion !== r.expectedPasswordVersion ||
      this.epochs.get(r.principalId) !== r.expectedAuthEpoch
    )
      return ok('stale' as const);
    if (
      !this.#consume(
        r.challengeId,
        r.principalId,
        r.consumedAtMs,
        'password_reset',
      )
    )
      return ok('stale' as const);
    this.credentials.set(r.principalId, {
      ...cred,
      passwordHash: r.passwordHash,
      passwordVersion: cred.passwordVersion + 1,
      changedAtMs: r.changedAtMs,
      verifiedAtMs: r.setVerified
        ? (cred.verifiedAtMs ?? r.consumedAtMs)
        : cred.verifiedAtMs,
    });
    this.epochs.set(r.principalId, r.expectedAuthEpoch + 1);
    return ok('committed' as const);
  }
}
type Finish = { route?: string; scope?: Scope; completion: Completion };
class Recording implements Observer {
  readonly finishes: Finish[] = [];
  start(): Observation {
    return {
      run: (fn) => fn(),
      finish: (completion, route, scope) => {
        this.finishes.push({ completion, route, scope });
      },
    };
  }
}
/** Cookie jar client; a cleared cookie (Max-Age=0) is dropped from the jar. */
class Client {
  cookies = new Map<string, string>();
  async call(
    method: 'GET' | 'POST',
    path: string,
    options: {
      body?: unknown;
      raw?: string;
      origin?: string | null | readonly string[];
      csrf?: string;
      headers?: Record<string, string>;
      cookieHeader?: string;
    } = {},
  ) {
    const headers: [string, string][] = [];
    const origin = options.origin === undefined ? ORIGIN : options.origin;
    if (method === 'POST' && origin !== null)
      for (const o of Array.isArray(origin) ? origin : [origin])
        headers.push(['Origin', o]);
    if (options.csrf !== undefined)
      headers.push(['X-CSRF-Token', options.csrf]);
    const jar =
      options.cookieHeader ??
      [...this.cookies].map(([k, v]) => k + '=' + v).join('; ');
    if (jar) headers.push(['Cookie', jar]);
    for (const [k, v] of Object.entries(options.headers ?? {}))
      headers.push([k, v]);
    let body: string | undefined;
    if (options.raw !== undefined) body = options.raw;
    else if (options.body !== undefined) body = JSON.stringify(options.body);
    if (body !== undefined) headers.push(['Content-Type', 'application/json']);
    const r = await fetch(base + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const setCookies = r.headers.getSetCookie();
    for (const c of setCookies) {
      const [pair, ...attrs] = c.split(';');
      const [name, v] = pair.split('=');
      if (attrs.some((a) => a.trim().toLowerCase() === 'max-age=0'))
        this.cookies.delete(name);
      else this.cookies.set(name, v);
    }
    const text = await r.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: r.status, headers: r.headers, setCookies, json, text };
  }
  async csrf() {
    const r = await this.call('GET', '/v1/auth/csrf');
    expect(r.status).toBe(200);
    return (r.json as { csrf_token: string }).csrf_token;
  }
}

let http: NodeServer,
  app: INestApplication,
  logger: Runtime,
  base: string,
  observer: Recording,
  store: MemoryStore,
  clock: FakeClock;
const lines: string[] = [];
const mail = { verification: [] as string[], reset: [] as string[] };
const limiter = { permit: true, calls: 0 };
const config: TransportConfig = {
  sessionCookie: 'n2f_session',
  csrfCookie: 'n2f_csrf',
  secureCookies: false,
  devInsecureCookies: true,
  bindHost: '127.0.0.1',
  allowedOrigins: [ORIGIN],
  csrfTtlMs: 3_600_000,
  sessionAbsoluteMs: 43_200_000,
};
beforeAll(async () => {
  clock = new FakeClock(new Date('2026-09-12T12:00:00Z'));
  const ids = new V7(new SystemClock());
  const factory = new Factory(new SystemClock(), ids);
  let counter = 0;
  const entropy = (bytes: Uint8Array) => {
    counter++;
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = (i * 7 + counter * 13) & 0xff;
  };
  const created = createLogger({
    resource: { name: 'transport-spec' },
    format: 'json',
    clock: new SystemClock(),
    sink: {
      write: (line) => {
        lines.push(line);
      },
    },
  });
  logger = value(created);
  observer = new Recording();
  store = new MemoryStore();
  const hasher = value(
    PasswordHasher.create(entropy, {
      maxConcurrent: 1,
      maxQueued: 8,
      queueWaitMs: 5000,
    }),
  );
  const codec = value(TokenCodec.create(entropy));
  const ports: Ports = {
    clock,
    ids,
    hasher: {
      hash: (p) => hasher.hash(p),
      verify: async (i, r) => {
        const o = await hasher.verify(i, r);
        return o.ok ? ok(o.value === 'match') : o;
      },
      verifyAbsent: async (i) => {
        const o = await hasher.verifyAbsent(i);
        return o.ok ? ok(false) : o;
      },
    },
    codec: {
      issue: (purpose) => codec.issue(purpose),
      digest: (purpose, secret) => codec.digest(purpose, secret),
    },
    policy: {
      checkBlocklist: async (p) =>
        ok(p.secret().reveal() !== 'password123456789'),
    },
    limiter: {
      admit: async (): Promise<Result<Admission, Failure>> => {
        limiter.calls++;
        return ok(
          limiter.permit
            ? { permitted: true }
            : { permitted: false, retryAfterMs: 90_500 },
        );
      },
    },
    mail: {
      sendVerification: async (_to, token) => {
        mail.verification.push(token.reveal());
        return true;
      },
      sendReset: async (_to, token) => {
        mail.reset.push(token.reveal());
        return true;
      },
    },
    store,
  };
  const operations = {
    register: value(Register.create(ports, DEFAULT_CONFIG)),
    requestVerification: value(
      RequestVerification.create(ports, DEFAULT_CONFIG),
    ),
    verifyEmail: value(VerifyEmail.create(ports, DEFAULT_CONFIG)),
    login: value(Login.create(ports, DEFAULT_CONFIG)),
    authenticate: value(
      Authenticate.create(
        { clock, digester: ports.codec, resolver: store },
        { sessionIdleMs: DEFAULT_CONFIG.sessionIdleMs },
      ),
    ),
    logout: value(Logout.create(ports, DEFAULT_CONFIG)),
    logoutAll: value(LogoutAll.create(ports, DEFAULT_CONFIG)),
    changePassword: value(ChangePassword.create(ports, DEFAULT_CONFIG)),
    requestReset: value(RequestReset.create(ports, DEFAULT_CONFIG)),
    resetPassword: value(ResetPassword.create(ports, DEFAULT_CONFIG)),
    websocketTicket: value(WebSocketTicket.create({ clock, ids, codec: ports.codec, store }, DEFAULT_CONFIG)),
  };
  const transport = value(
    createTransport(config, {
      keyed: value(
        Digest.create(new SecretString('0123456789abcdef0123456789abcdef')),
      ),
      entropy,
      clock,
      digester: ports.codec,
      upgradeConsumer: store,
      operations,
    }),
  );
  const executor = value(actor('service', 'transport-spec'));
  const serverConfig: Config = {
    routes: transport.routes,
    observer,
    log: logger.log,
    now: () => clock.elapsed(),
    timeoutMs: 5000,
    maxBody: 8192,
    maxActive: 8,
    open: (name, incoming, at) =>
      factory.enter(
        {
          origin: 'request',
          operation: value(operation(name)),
          attribution: at,
          executor,
        },
        incoming,
      ),
  };
  const adapter = new Server(serverConfig);
  @Controller()
  class SpecController {
    @All('{*path}')
    handle(@Req() req: Request, @Res() res: Response) {
      return adapter.handle(req, res);
    }
  }
  @Module({ controllers: [SpecController] })
  class SpecModule {}
  app = await NestFactory.create(SpecModule, {
    logger: false,
    bodyParser: false,
  });
  app.use(adapter.middleware);
  await app.init();
  http = createServer(app.getHttpAdapter().getInstance());
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  base =
    'http://127.0.0.1:' +
    (typeof address === 'object' && address ? address.port : 0);
});
afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await app.close();
  await logger.close(1000);
});
const lastScope = () => observer.finishes[observer.finishes.length - 1]?.scope;
const code = (r: { json: unknown }) => (r.json as { code?: string }).code;
const attrs = (setCookie: string) =>
  setCookie
    .split(';')
    .slice(1)
    .map((a) => a.trim());

describe('configuration (R01)', () => {
  it('refuses insecure cookies without the development flag, bad names, origins and lifetimes', () => {
    const deps = {
      keyed: undefined,
      entropy: undefined,
      clock,
      digester: undefined,
      operations: undefined,
    } as never;
    const check = (patch: Partial<TransportConfig>) =>
      createTransport({ ...config, ...patch }, deps);
    for (const patch of [
      { devInsecureCookies: false },
      { bindHost: '10.0.0.5' },
      { sessionCookie: '__Host-n2f_session' },
      { csrfCookie: 'bad name' },
      { allowedOrigins: [] },
      { allowedOrigins: ['http://app.test/'] },
      { allowedOrigins: ['*'] },
      { csrfTtlMs: 3_600_001 },
      { csrfTtlMs: 0 },
      { sessionAbsoluteMs: 0 },
    ] as Partial<TransportConfig>[]) {
      const r = check(patch);
      expect(r.ok, JSON.stringify(patch)).toBe(false);
      if (!r.ok) expect(r.error.type).toBe('identity.transport_configuration');
    }
  });
});

describe('CSRF context and origin admission (R04–R06)', () => {
  it('issues a token with a fresh HttpOnly cookie and no-store', async () => {
    const c = new Client();
    const r = await c.call('GET', '/v1/auth/csrf');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const token = (r.json as { csrf_token: string }).csrf_token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}\.\d+\.[A-Za-z0-9_-]{43}$/);
    const cookie = r.setCookies.find((s) => s.startsWith('n2f_csrf='))!;
    expect(cookie.split(';')[0]).toBe('n2f_csrf=' + token);
    expect(attrs(cookie)).toEqual([
      'Path=/',
      'Max-Age=3600',
      'HttpOnly',
      'SameSite=Lax',
    ]);
    expect(lastScope()!.snapshot().work.attribution.initiator?.kind).toBe(
      'anonymous',
    );
  });
  it('refuses a POST without, with repeated, or with an unlisted Origin', async () => {
    const c = new Client();
    const token = await c.csrf();
    const body = { email: 'origin@example.com', password: PASSWORD };
    for (const origin of [
      null,
      [ORIGIN, ORIGIN],
      'http://evil.test',
    ] as const) {
      const r = await c.call('POST', '/v1/auth/register', {
        body,
        origin,
        csrf: token,
      });
      expect(r.status).toBe(403);
      expect(code(r)).toBe('identity.origin_rejected');
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
    expect(store.credentials.size).toBe(0);
  });
  it('refuses a missing, mismatched, forged, expired or unbound CSRF context', async () => {
    const c = new Client();
    const body = { email: 'csrf@example.com', password: PASSWORD };
    let r = await c.call('POST', '/v1/auth/register', { body });
    expect([r.status, code(r)]).toEqual([403, 'identity.csrf_rejected']);
    const token = await c.csrf();
    r = await c.call('POST', '/v1/auth/register', {
      body,
      csrf: token.slice(0, -1) + 'x',
    });
    expect([r.status, code(r)]).toEqual([403, 'identity.csrf_rejected']);
    const [nonce, issued] = token.split('.');
    const forged = nonce + '.' + issued + '.' + 'A'.repeat(43);
    r = await c.call('POST', '/v1/auth/register', {
      body,
      csrf: forged,
      cookieHeader: 'n2f_csrf=' + forged,
    });
    expect([r.status, code(r)]).toEqual([403, 'identity.csrf_rejected']);
    r = await c.call('POST', '/v1/auth/register', {
      body,
      csrf: token,
      cookieHeader: 'n2f_csrf=' + token + '; n2f_csrf=' + token,
    });
    expect([r.status, code(r)]).toEqual([403, 'identity.csrf_rejected']);
    clock.set(new Date(clock.now().getTime() + 3_600_001));
    r = await c.call('POST', '/v1/auth/register', { body, csrf: token });
    expect([r.status, code(r)]).toEqual([403, 'identity.csrf_rejected']);
    clock.set(new Date(clock.now().getTime() - 3_600_001));
    expect(store.credentials.size).toBe(0);
  });
});

describe('registration, verification and login (R02, R09, R10)', () => {
  const c = new Client();
  let token: string;
  it('accepts a registration and a duplicate identically, refusing malformed bodies', async () => {
    token = await c.csrf();
    let r = await c.call('POST', '/v1/auth/register', {
      raw:
        '{"email": "a@example.com", "password": "' +
        PASSWORD +
        '", "extra": 1}',
      csrf: token,
    });
    expect([r.status, code(r)]).toEqual([400, 'http.invalid_body']);
    r = await c.call('POST', '/v1/auth/register', {
      raw:
        '{"email": "a@example.com", "email": "b@example.com", "password": "' +
        PASSWORD +
        '"}',
      csrf: token,
    });
    expect([r.status, code(r)]).toEqual([400, 'http.invalid_body']);
    r = await c.call('POST', '/v1/auth/register', {
      raw: '{"email": 1, "password": "' + PASSWORD + '"}',
      csrf: token,
    });
    expect([r.status, code(r)]).toEqual([400, 'http.invalid_body']);
    r = await c.call('POST', '/v1/auth/register', { raw: '[]', csrf: token });
    expect([r.status, code(r)]).toEqual([400, 'http.invalid_body']);
    r = await c.call('POST', '/v1/auth/register', {
      body: { email: 'ada@example.com', password: 'password123456789' },
      csrf: token,
    });
    expect([r.status, code(r)]).toEqual([400, 'identity.password_invalid']);
    r = await c.call('POST', '/v1/auth/register', {
      body: { email: 'ada@example.com', password: PASSWORD },
      csrf: token,
    });
    expect([r.status, r.json]).toEqual([202, { accepted: true }]);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const again = await c.call('POST', '/v1/auth/register', {
      body: { email: 'ada@example.com', password: PASSWORD },
      csrf: token,
    });
    expect([again.status, again.json]).toEqual([202, { accepted: true }]);
    expect(mail.verification).toHaveLength(1);
    expect(store.credentials.size).toBe(1);
  });
  it('refuses login for wrong password and unverified email with one identical body', async () => {
    const wrong = await c.call('POST', '/v1/auth/login', {
      body: { email: 'ada@example.com', password: PASSWORD + '!' },
      csrf: token,
    });
    const unverified = await c.call('POST', '/v1/auth/login', {
      body: { email: 'ada@example.com', password: PASSWORD },
      csrf: token,
    });
    const unknown = await c.call('POST', '/v1/auth/login', {
      body: { email: 'nobody@example.com', password: PASSWORD },
      csrf: token,
    });
    const strip = (j: unknown) => {
      const { request_id, correlation_id, ...rest } = j as Record<
        string,
        unknown
      >;
      void request_id;
      void correlation_id;
      return rest;
    };
    expect([wrong.status, unverified.status, unknown.status]).toEqual([
      401, 401, 401,
    ]);
    expect(strip(wrong.json)).toEqual(strip(unverified.json));
    expect(strip(wrong.json)).toEqual(strip(unknown.json));
    expect(code(wrong)).toBe('identity.credentials_rejected');
    expect(JSON.stringify(wrong.json)).not.toMatch(/password|email/i);
    expect(c.cookies.has('n2f_session')).toBe(false);
  });
  it('verifies the email with the mailed token and password proof, then logs in with cookies', async () => {
    let r = await c.call('POST', '/v1/auth/email/verification-requests', {
      body: { email: 'ada@example.com' },
      csrf: token,
    });
    expect([r.status, r.json]).toEqual([202, { accepted: true }]);
    expect(mail.verification).toHaveLength(2);
    r = await c.call('POST', '/v1/auth/email/verify', {
      body: { token: mail.verification[0], password: PASSWORD },
      csrf: token,
    });
    expect([r.status, code(r)]).toEqual([401, 'identity.challenge_rejected']);
    r = await c.call('POST', '/v1/auth/email/verify', {
      body: { token: mail.verification[1], password: PASSWORD + '!' },
      csrf: token,
    });
    expect([r.status, code(r)]).toEqual([401, 'identity.challenge_rejected']);
    r = await c.call('POST', '/v1/auth/email/verify', {
      body: { token: mail.verification[1], password: PASSWORD },
      csrf: token,
    });
    expect(r.status).toBe(204);
    expect(c.cookies.has('n2f_session')).toBe(false);
    r = await c.call('POST', '/v1/auth/login', {
      body: { email: 'ada@example.com', password: PASSWORD },
      csrf: token,
    });
    expect(r.status).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'absolute_expires_at_ms',
      'csrf_token',
      'idle_expires_at_ms',
      'principal_id',
    ]);
    expect(JSON.stringify(body)).not.toContain(c.cookies.get('n2f_session'));
    const session = r.setCookies.find((s) => s.startsWith('n2f_session='))!;
    expect(attrs(session)).toEqual([
      'Path=/',
      'Max-Age=43200',
      'HttpOnly',
      'SameSite=Lax',
    ]);
    expect(c.cookies.get('n2f_csrf')).toBe(body.csrf_token);
    expect(c.cookies.get('n2f_csrf')).not.toBe(token);
    token = body.csrf_token as string;
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
  it('resolves the session with a user initiator, refuses anonymous CSRF on session routes and duplicate cookies before lookup', async () => {
    let r = await c.call('GET', '/v1/auth/session');
    expect(r.status).toBe(200);
    expect(Object.keys(r.json as object).sort()).toEqual([
      'auth_epoch',
      'principal_id',
    ]);
    const initiator = lastScope()!.snapshot().work.attribution.initiator!;
    expect(initiator.kind).toBe('user');
    expect(initiator.identity).toBe(
      (r.json as { principal_id: string }).principal_id,
    );
    const anon = new Client();
    r = await anon.call('GET', '/v1/auth/session');
    expect([r.status, code(r)]).toEqual([401, 'identity.session_rejected']);
    const calls = store.resolveCalls;
    const sessionValue = c.cookies.get('n2f_session')!;
    const jar = new Map(c.cookies);
    r = await c.call('GET', '/v1/auth/session', {
      cookieHeader:
        'n2f_session=' + sessionValue + '; n2f_session=' + sessionValue,
    });
    c.cookies = jar; // the refusal cleared the cookie; keep the real session for the next steps
    expect([r.status, code(r)]).toEqual([401, 'identity.session_rejected']);
    expect(store.resolveCalls).toBe(calls);
    expect(
      r.setCookies.some(
        (s) => s.startsWith('n2f_session=;') && s.includes('Max-Age=0'),
      ),
    ).toBe(true);
    const anonymousToken = await anon.csrf();
    r = await c.call('POST', '/v1/auth/logout-all', {
      csrf: anonymousToken,
      cookieHeader:
        'n2f_session=' + sessionValue + '; n2f_csrf=' + anonymousToken,
    });
    expect([r.status, code(r)]).toEqual([403, 'identity.csrf_rejected']);
    r = await c.call('POST', '/v1/auth/register', {
      body: { email: 'other@example.com', password: PASSWORD },
      csrf: token,
      cookieHeader: 'n2f_csrf=' + token,
    });
    expect([r.status, code(r)]).toEqual([403, 'identity.csrf_rejected']);
  });
  it('changes the password with the session, clears cookies and rejects the old session', async () => {
    const oldSession = c.cookies.get('n2f_session')!;
    let r = await c.call('POST', '/v1/auth/password/change', {
      body: {
        current_password: PASSWORD + '!',
        new_password: PASSWORD + ' two',
      },
      csrf: token,
    });
    expect([r.status, code(r)]).toEqual([401, 'identity.credentials_rejected']);
    expect(c.cookies.has('n2f_session')).toBe(true);
    r = await c.call('POST', '/v1/auth/password/change', {
      body: { current_password: PASSWORD, new_password: PASSWORD + ' two' },
      csrf: token,
    });
    expect(r.status).toBe(204);
    expect(c.cookies.has('n2f_session')).toBe(false);
    expect(c.cookies.has('n2f_csrf')).toBe(false);
    r = await c.call('GET', '/v1/auth/session', {
      cookieHeader: 'n2f_session=' + oldSession,
    });
    expect([r.status, code(r)]).toEqual([401, 'identity.session_rejected']);
    token = await c.csrf();
    r = await c.call('POST', '/v1/auth/login', {
      body: { email: 'ada@example.com', password: PASSWORD },
      csrf: token,
    });
    expect(r.status).toBe(401);
    r = await c.call('POST', '/v1/auth/login', {
      body: { email: 'ada@example.com', password: PASSWORD + ' two' },
      csrf: token,
    });
    expect(r.status).toBe(200);
    token = (r.json as { csrf_token: string }).csrf_token;
  });
  it('logs out idempotently, clearing the session cookie and rotating CSRF; logout-all invalidates every session', async () => {
    let r = await c.call('POST', '/v1/auth/logout', { csrf: token });
    expect(r.status).toBe(204);
    expect(
      r.setCookies.some(
        (s) => s.startsWith('n2f_session=;') && s.includes('Max-Age=0'),
      ),
    ).toBe(true);
    expect(c.cookies.has('n2f_session')).toBe(false);
    expect(c.cookies.get('n2f_csrf')).not.toBe(token);
    token = await c.csrf();
    r = await c.call('POST', '/v1/auth/logout', { csrf: token });
    expect(r.status).toBe(204);
    expect(c.cookies.get('n2f_csrf')).not.toBe(token); // every logout rotates (R11)
    token = await c.csrf();
    r = await c.call('POST', '/v1/auth/login', {
      body: { email: 'ada@example.com', password: PASSWORD + ' two' },
      csrf: token,
    });
    expect(r.status).toBe(200);
    token = (r.json as { csrf_token: string }).csrf_token;
    const other = new Client();
    let o = await other.call('GET', '/v1/auth/csrf');
    o = await other.call('POST', '/v1/auth/login', {
      body: { email: 'ada@example.com', password: PASSWORD + ' two' },
      csrf: (o.json as { csrf_token: string }).csrf_token,
    });
    expect(o.status).toBe(200);
    r = await c.call('POST', '/v1/auth/logout-all', { csrf: token });
    expect(r.status).toBe(204);
    expect(c.cookies.size).toBe(0);
    o = await other.call('GET', '/v1/auth/session');
    expect([o.status, code(o)]).toEqual([401, 'identity.session_rejected']);
  });
  it('requests a reset and resets the password with the mailed token, issuing no session', async () => {
    token = await c.csrf();
    let r = await c.call('POST', '/v1/auth/password/reset-requests', {
      body: { email: 'nobody@example.com' },
      csrf: token,
    });
    expect([r.status, r.json]).toEqual([202, { accepted: true }]);
    r = await c.call('POST', '/v1/auth/password/reset-requests', {
      body: { email: 'ada@example.com' },
      csrf: token,
    });
    expect([r.status, r.json]).toEqual([202, { accepted: true }]);
    expect(mail.reset).toHaveLength(1);
    r = await c.call('POST', '/v1/auth/password/reset', {
      body: { token: mail.reset[0], password: PASSWORD + ' three' },
      csrf: token,
    });
    expect(r.status).toBe(204);
    expect(c.cookies.has('n2f_session')).toBe(false);
    r = await c.call('POST', '/v1/auth/password/reset', {
      body: { token: mail.reset[0], password: PASSWORD + ' four' },
      csrf: token,
    });
    expect([r.status, code(r)]).toEqual([401, 'identity.challenge_rejected']);
    r = await c.call('POST', '/v1/auth/login', {
      body: { email: 'ada@example.com', password: PASSWORD + ' three' },
      csrf: token,
    });
    expect(r.status).toBe(200);
    token = (r.json as { csrf_token: string }).csrf_token;
  });
  it('projects rate limits as 429 with Retry-After and dependency failures as 503', async () => {
    limiter.permit = false;
    let r = await c.call('POST', '/v1/auth/register', {
      body: { email: 'z@example.com', password: PASSWORD },
      csrf: token,
    });
    limiter.permit = true;
    expect([r.status, code(r), r.headers.get('retry-after')]).toEqual([
      429,
      'identity.auth_rate_limited',
      '91',
    ]);
    store.fail = failure('unavailable', 'database down', {
      type: 'database.unavailable',
    });
    r = await c.call('POST', '/v1/auth/register', {
      body: { email: 'z@example.com', password: PASSWORD },
      csrf: token,
    });
    store.fail = undefined;
    expect([r.status, code(r)]).toEqual([503, 'database.unavailable']);
  });
  it('never places private values in completion logs or problem bodies', () => {
    const text = lines.join('');
    expect(text).toContain('http.request.completed');
    expect(text).not.toContain('SENTINEL');
    expect(text).not.toContain('ada@example.com');
    expect(text).not.toContain('n2f_csrf=');
    for (const secret of [...mail.verification, ...mail.reset])
      expect(text).not.toContain(secret);
    expect(observer.finishes.some((f) => f.route === '/v1/auth/login')).toBe(
      true,
    );
  });
});
