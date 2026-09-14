/**
 * Identity HTTP transport (CONTRACT.md R01–R15): registers the authentication
 * routes on the shared feature-route boundary, owns cookie, origin and CSRF
 * policy, admits sessions through the Authenticate query and maps the caller to
 * a user initiator. No business rule, SQL or crypto beyond the keyed digest.
 * @module modules/identity/transport/http
 */
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import {
  err,
  failure,
  kindOf,
  ok,
  publicInfo,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import {
  Refuse,
  Reply,
  parseCookies,
  type Admission,
  type CookieValue,
  type FeatureRequest,
} from '../../../../shared/http/feature.js';
import type {
  RequestContext,
  Route,
} from '../../../../shared/http/nest/server.js';
import { parse, type Entropy, type ID } from '../../../../shared/id/index.js';
import type { Digest } from '../../../../shared/keyed/index.js';
import { actor } from '../../../../shared/provenance/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import type {
  ChangePassword,
  Clock,
  Login,
  Logout,
  LogoutAll,
  Register,
  RequestReset,
  RequestVerification,
  ResetPassword,
  TokenCodecPort,
  VerifyEmail,
  WebSocketTicket,
  UpgradeTicketStore,
} from '../../app/command/index.js';
import type {
  Authenticate,
  AuthenticatedPrincipal,
} from '../../app/query/index.js';
import { ANONYMOUS, issueCsrf, verifyCsrf } from './csrf.js';
import { stringFields } from './json.js';

export type TransportConfig = Readonly<{
  sessionCookie: string;
  csrfCookie: string;
  secureCookies: boolean;
  devInsecureCookies: boolean;
  bindHost: string;
  allowedOrigins: readonly string[];
  csrfTtlMs: number;
  sessionAbsoluteMs: number;
}>;
export type Operations = Readonly<{
  register: Register;
  requestVerification: RequestVerification;
  verifyEmail: VerifyEmail;
  login: Login;
  authenticate: Authenticate;
  logout: Logout;
  logoutAll: LogoutAll;
  changePassword: ChangePassword;
  requestReset: RequestReset;
  resetPassword: ResetPassword;
  websocketTicket: WebSocketTicket;
}>;
export type TransportDeps = Readonly<{
  keyed: Digest;
  entropy: Entropy;
  clock: Clock;
  digester: Pick<TokenCodecPort, 'digest'>;
  upgradeConsumer: Pick<UpgradeTicketStore, 'consumeUpgradeTicket'>;
  operations: Operations;
}>;
export type SessionAdmission = NonNullable<Route['admission']>;
export type Transport = Readonly<{
  routes: readonly Route[];
  requireSession: SessionAdmission;
  requireSessionPost: SessionAdmission;
  authorizeWebSocket: (
    request: IncomingMessage,
  ) => Promise<Result<WebSocketAdmission, Failure>>;
  revalidateWebSocket: (admitted: unknown) => Promise<Result<void, Failure>>;
}>;

/** Opaque socket admission: only identity can use the session credential. */
export class WebSocketAdmission {
  constructor(
    readonly principal: AuthenticatedPrincipal,
    session: SecretString,
  ) {
    websocketSessions.set(this, session);
    Object.freeze(this);
  }
}

/** Extracts only the safe principal reference for a root-owned route. */
export function principalIdOf(admitted: unknown): Result<ID, Failure> {
  if (!admitted || typeof admitted !== 'object')
    return err(failure('internal', 'invalid session admission', { type: 'identity.admission_corrupt' }));
  const principal = (admitted as { principal?: AuthenticatedPrincipal }).principal;
  if (!principal || !parse(principal.principalId).ok)
    return err(failure('internal', 'invalid session admission', { type: 'identity.admission_corrupt' }));
  return ok(principal.principalId);
}
const websocketSessions = new WeakMap<WebSocketAdmission, SecretString>();

const MAX_CSRF_TTL_MS = 3_600_000;
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;
const configuration = (): Failure =>
  failure('invalid', 'invalid identity transport configuration', {
    type: 'identity.transport_configuration',
  });
const originRejected = (): Failure =>
  failure('forbidden', 'origin rejected', { type: 'identity.origin_rejected' });
const csrfRejected = (): Failure =>
  failure('forbidden', 'csrf rejected', { type: 'identity.csrf_rejected' });
const sessionRejected = (): Failure =>
  failure('unauthenticated', 'session rejected', {
    type: 'identity.session_rejected',
  });
const dependencyFailed = (cause?: unknown): Failure =>
  failure('unavailable', 'authentication dependency failed', {
    type: 'identity.auth_dependency_failed',
    cause,
  });
const isLoopback = (host: string) =>
  host === 'localhost' ||
  host === '127.0.0.1' ||
  host === '::1' ||
  (isIP(host) === 4 && host.startsWith('127.'));
export function validateTransportConfig(
  c: TransportConfig,
): Result<TransportConfig, Failure> {
  if (
    typeof c !== 'object' ||
    c === null ||
    typeof c.sessionCookie !== 'string' ||
    typeof c.csrfCookie !== 'string' ||
    !COOKIE_NAME.test(c.sessionCookie) ||
    !COOKIE_NAME.test(c.csrfCookie) ||
    c.sessionCookie === c.csrfCookie ||
    typeof c.secureCookies !== 'boolean' ||
    typeof c.devInsecureCookies !== 'boolean' ||
    typeof c.bindHost !== 'string' ||
    !Array.isArray(c.allowedOrigins) ||
    c.allowedOrigins.length === 0 ||
    c.allowedOrigins.some((o) => typeof o !== 'string' || !ORIGIN.test(o)) ||
    !Number.isSafeInteger(c.csrfTtlMs) ||
    c.csrfTtlMs < 1 ||
    c.csrfTtlMs > MAX_CSRF_TTL_MS ||
    !Number.isSafeInteger(c.sessionAbsoluteMs) ||
    c.sessionAbsoluteMs < 1000
  )
    return err(configuration());
  if (!c.secureCookies && !(c.devInsecureCookies && isLoopback(c.bindHost)))
    return err(configuration());
  if (
    !c.secureCookies &&
    (c.sessionCookie.startsWith('__Host-') ||
      c.csrfCookie.startsWith('__Host-'))
  )
    return err(configuration());
  return ok(
    Object.freeze({
      ...c,
      allowedOrigins: Object.freeze([...c.allowedOrigins]),
    }),
  );
}

type SessionState =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'admitted'; principal: AuthenticatedPrincipal; binding: string };
/** What admission hands the handler: the caller and its CSRF binding. */
type Admitted = Readonly<{
  principal?: AuthenticatedPrincipal;
  binding: string;
}>;
type Mode = 'anonymous' | 'session-optional' | 'session-required';

class IdentityTransport {
  readonly #c: TransportConfig;
  readonly #d: TransportDeps;
  constructor(c: TransportConfig, d: TransportDeps) {
    this.#c = c;
    this.#d = d;
  }
  #cookie(name: string, value: string, maxAgeMs: number): CookieValue {
    return {
      name,
      value,
      path: '/',
      maxAge: Math.floor(maxAgeMs / 1000),
      secure: this.#c.secureCookies,
      httpOnly: true,
      sameSite: 'Lax',
    };
  }
  #clearSession(): CookieValue {
    return this.#cookie(this.#c.sessionCookie, '', 0);
  }
  #clearCsrf(): CookieValue {
    return this.#cookie(this.#c.csrfCookie, '', 0);
  }
  #now(): Result<number, Failure> {
    try {
      const ms = this.#d.clock.now().getTime();
      return Number.isSafeInteger(ms) && ms >= 0
        ? ok(ms)
        : err(dependencyFailed());
    } catch (cause) {
      return err(dependencyFailed(cause));
    }
  }
  #headerValues(request: IncomingMessage, name: string): string[] {
    const values: string[] = [];
    for (let i = 0; i < request.rawHeaders.length; i += 2)
      if (request.rawHeaders[i].toLowerCase() === name)
        values.push(request.rawHeaders[i + 1]);
    return values;
  }
  async authorizeWebSocket(
    request: IncomingMessage,
  ): Promise<Result<WebSocketAdmission, Failure>> {
    const origins = this.#headerValues(request, 'origin');
    if (origins.length !== 1 || !this.#c.allowedOrigins.includes(origins[0]))
      return err(originRejected());
    const cookies = parseCookies(request.headers.cookie);
    const sessions = cookies.get(this.#c.sessionCookie) ?? [];
    if (sessions.length !== 1) return err(sessionRejected());
    const protocols = this.#headerValues(request, 'sec-websocket-protocol');
    let version = false;
    let ticket: string | undefined;
    for (const header of protocols)
      for (const raw of header.split(',')) {
        const part = raw.trim();
        if (part === 'n2f.v1') {
          if (version) return err(sessionRejected());
          version = true;
        } else if (part.startsWith('n2f.ticket.')) {
          const value = part.slice('n2f.ticket.'.length);
          if (ticket !== undefined || value === '') return err(sessionRejected());
          ticket = value;
        } else return err(sessionRejected());
      }
    if (!version || ticket === undefined) return err(sessionRejected());
    const session = new SecretString(sessions[0]);
    const authenticated = await this.#d.operations.authenticate.execute({
      token: session,
    });
    if (!authenticated.ok) return authenticated;
    const digest = this.#d.digester.digest(
      'websocket_upgrade',
      new SecretString(ticket),
    );
    if (!digest.ok) return err(sessionRejected());
    const now = this.#now();
    if (!now.ok) return now;
    const consumed = await this.#d.upgradeConsumer.consumeUpgradeTicket(
      digest.value,
      now.value,
    );
    if (!consumed.ok) return consumed;
    const admission = consumed.value;
    const principal = authenticated.value;
    if (
      !admission ||
      admission.principalId !== principal.principalId ||
      admission.sessionId !== principal.sessionId ||
      admission.authEpoch !== principal.authEpoch
    )
      return err(sessionRejected());
    return ok(new WebSocketAdmission(principal, session));
  }
  async revalidateWebSocket(
    admitted: unknown,
  ): Promise<Result<void, Failure>> {
    if (!(admitted instanceof WebSocketAdmission))
      return err(failure('internal', 'invalid websocket admission', {
        type: 'socket.admission_corrupt',
      }));
    const session = websocketSessions.get(admitted);
    if (!session)
      return err(failure('internal', 'invalid websocket admission', {
        type: 'socket.admission_corrupt',
      }));
    const authenticated = await this.#d.operations.authenticate.execute({
      token: session,
    });
    if (!authenticated.ok) return err(authenticated.error);
    const principal = authenticated.value;
    if (
      principal.principalId !== admitted.principal.principalId ||
      principal.sessionId !== admitted.principal.sessionId ||
      principal.authEpoch !== admitted.principal.authEpoch
    )
      return err(sessionRejected());
    return ok(undefined);
  }
  #freshCsrf(
    binding: string,
  ): Result<{ token: string; cookie: CookieValue }, Failure> {
    const now = this.#now();
    if (!now.ok) return now;
    const token = issueCsrf(this.#d.keyed, this.#d.entropy, now.value, binding);
    if (!token.ok) return token;
    return ok({
      token: token.value,
      cookie: this.#cookie(this.#c.csrfCookie, token.value, this.#c.csrfTtlMs),
    });
  }
  /** Refusals carry no-store and, when the session is at fault, a cleared cookie (R07, R12). */
  #refuse(
    error: Failure,
    cookies: readonly CookieValue[] = [],
  ): Result<never, unknown> {
    const wrapped = Refuse.create(error, {
      headers: { 'Cache-Control': 'no-store' },
      cookies,
    });
    return err(wrapped.ok ? wrapped.value : error);
  }
  #reply(
    status: 200 | 202 | 204,
    body: unknown,
    cookies: readonly CookieValue[] = [],
  ): Result<Reply, unknown> {
    return Reply.create({
      status,
      ...(status === 204 ? {} : { body }),
      headers: { 'Cache-Control': 'no-store' },
      cookies,
    });
  }
  async #session(
    request: FeatureRequest,
  ): Promise<Result<SessionState, unknown>> {
    const values = request.cookies.get(this.#c.sessionCookie) ?? [];
    if (values.length > 1)
      return this.#refuse(sessionRejected(), [this.#clearSession()]);
    if (values.length === 0) return ok({ kind: 'none' });
    const token = new SecretString(values[0]);
    const digest = this.#d.digester.digest('session', token);
    if (!digest.ok) return ok({ kind: 'invalid' });
    const admitted = await this.#d.operations.authenticate.execute({ token });
    if (!admitted.ok) {
      if (kindOf(admitted.error) === 'unauthenticated')
        return ok({ kind: 'invalid' });
      return this.#refuse(admitted.error);
    }
    return ok({
      kind: 'admitted',
      principal: admitted.value,
      binding: Buffer.from(digest.value.bytes()).toString('hex'),
    });
  }
  #origin(request: FeatureRequest): boolean {
    const origins = request.headers.origin;
    return origins.length === 1 && this.#c.allowedOrigins.includes(origins[0]);
  }
  #csrf(request: FeatureRequest, binding: string): Result<void, unknown> {
    const cookies = request.cookies.get(this.#c.csrfCookie) ?? [];
    const headers = request.headers['x-csrf-token'];
    if (
      cookies.length !== 1 ||
      headers.length !== 1 ||
      cookies[0] !== headers[0]
    )
      return this.#refuse(csrfRejected());
    const now = this.#now();
    if (!now.ok) return this.#refuse(now.error);
    if (
      !verifyCsrf(
        this.#d.keyed,
        headers[0],
        now.value,
        this.#c.csrfTtlMs,
        binding,
      )
    )
      return this.#refuse(csrfRejected());
    return ok(undefined);
  }
  #admission(mode: Mode, post: boolean) {
    return async (
      request: FeatureRequest,
    ): Promise<Result<Admission, unknown>> => {
      if (post && !this.#origin(request)) return this.#refuse(originRejected());
      const session = await this.#session(request);
      if (!session.ok) return session;
      const s = session.value;
      if (mode !== 'anonymous' && s.kind === 'invalid')
        return this.#refuse(sessionRejected(), [this.#clearSession()]);
      if (mode === 'session-required' && s.kind !== 'admitted')
        return this.#refuse(sessionRejected(), [this.#clearSession()]);
      const binding = s.kind === 'admitted' ? s.binding : ANONYMOUS;
      if (post) {
        const csrf = this.#csrf(request, binding);
        if (!csrf.ok) return csrf;
      }
      if (s.kind !== 'admitted')
        return ok({
          kind: 'anonymous',
          admitted: { binding } as Admitted,
        } as Admission);
      const initiator = actor('user', s.principal.principalId);
      if (!initiator.ok) return this.#refuse(dependencyFailed(initiator.error));
      const admitted: Admitted = { principal: s.principal, binding };
      return ok({
        kind: 'authenticated',
        initiator: initiator.value,
        admitted,
      });
    };
  }
  #admitted(context: RequestContext): Admitted {
    const a = context.request.admitted as Admitted | undefined;
    return a ?? { binding: ANONYMOUS };
  }
  /** Application refusals keep their public projection; rate limits gain Retry-After (R08). */
  #failure(
    error: Failure,
    cookies: readonly CookieValue[] = [],
  ): Result<never, unknown> {
    const info = publicInfo(error);
    if (info.type === 'identity.auth_rate_limited') {
      const ms = Number(info.fields?.retry_after_ms ?? '0');
      const seconds = Math.max(
        1,
        Math.ceil((Number.isFinite(ms) ? ms : 0) / 1000),
      );
      const wrapped = Refuse.create(error, {
        headers: {
          'Cache-Control': 'no-store',
          'Retry-After': String(seconds),
        },
        cookies,
      });
      return err(wrapped.ok ? wrapped.value : error);
    }
    return this.#refuse(error, cookies);
  }
  #route(
    method: 'GET' | 'POST',
    name: string,
    mode: Mode,
    handler: (context: RequestContext) => Promise<Result<Reply, unknown>>,
  ): Route {
    return {
      path: '/v1/auth/' + name,
      method,
      operation: 'identity.http.' + name.replace(/[/-]/g, '_'),
      admission: this.#admission(mode, method === 'POST'),
      handler,
    };
  }
  routes(): Route[] {
    const ops = this.#d.operations;
    const accepted = { accepted: true };
    return [
      this.#route('GET', 'csrf', 'anonymous', async (context) => {
        const fresh = this.#freshCsrf(this.#admitted(context).binding);
        if (!fresh.ok) return this.#refuse(fresh.error);
        return this.#reply(200, { csrf_token: fresh.value.token }, [
          fresh.value.cookie,
        ]);
      }),
      this.#route('POST', 'register', 'anonymous', async (context) => {
        const body = stringFields(context.request.body, ['email', 'password']);
        if (!body.ok) return this.#refuse(body.error);
        const r = await ops.register.execute({
          email: body.value.email,
          password: new SecretString(body.value.password),
          source: context.request.source,
          work: context.scope.workContext(),
        });
        return r.ok ? this.#reply(202, accepted) : this.#failure(r.error);
      }),
      this.#route(
        'POST',
        'email/verification-requests',
        'anonymous',
        async (context) => {
          const body = stringFields(context.request.body, ['email']);
          if (!body.ok) return this.#refuse(body.error);
          const r = await ops.requestVerification.execute({
            email: body.value.email,
            source: context.request.source,
            work: context.scope.workContext(),
          });
          return r.ok ? this.#reply(202, accepted) : this.#failure(r.error);
        },
      ),
      this.#route('POST', 'email/verify', 'anonymous', async (context) => {
        const body = stringFields(context.request.body, ['token', 'password']);
        if (!body.ok) return this.#refuse(body.error);
        const r = await ops.verifyEmail.execute({
          token: new SecretString(body.value.token),
          password: new SecretString(body.value.password),
          source: context.request.source,
          work: context.scope.workContext(),
        });
        return r.ok ? this.#reply(204, undefined) : this.#failure(r.error);
      }),
      this.#route('POST', 'login', 'anonymous', async (context) => {
        const body = stringFields(context.request.body, ['email', 'password']);
        if (!body.ok) return this.#refuse(body.error);
        const r = await ops.login.execute({
          email: body.value.email,
          password: new SecretString(body.value.password),
          source: context.request.source,
          work: context.scope.workContext(),
        });
        if (!r.ok) return this.#failure(r.error, [this.#clearSession()]);
        const digest = this.#d.digester.digest('session', r.value.token);
        if (!digest.ok) return this.#refuse(dependencyFailed(digest.error));
        const fresh = this.#freshCsrf(
          Buffer.from(digest.value.bytes()).toString('hex'),
        );
        if (!fresh.ok) return this.#refuse(fresh.error);
        return this.#reply(
          200,
          {
            principal_id: r.value.principal.id,
            absolute_expires_at_ms: r.value.absoluteExpiresAtMs,
            idle_expires_at_ms: r.value.idleExpiresAtMs,
            csrf_token: fresh.value.token,
          },
          [
            this.#cookie(
              this.#c.sessionCookie,
              r.value.token.reveal(),
              this.#c.sessionAbsoluteMs,
            ),
            fresh.value.cookie,
          ],
        );
      }),
      this.#route('GET', 'session', 'session-required', async (context) => {
        const caller = this.#admitted(context).principal!;
        return this.#reply(200, {
          principal_id: caller.principalId,
          auth_epoch: caller.authEpoch,
        });
      }),
      this.#route('POST', 'websocket-ticket', 'session-required', async (context) => {
        if (context.request.body.byteLength !== 0) return this.#refuse(failure('invalid', 'invalid request body', { type: 'http.invalid_body' }));
        const caller = this.#admitted(context).principal!;
        const r = await ops.websocketTicket.execute({ caller, work: context.scope.workContext() });
        return r.ok ? this.#reply(200, { ticket: r.value.ticket.reveal(), expires_at_ms: r.value.expiresAtMs }) : this.#failure(r.error);
      }),
      this.#route('POST', 'logout', 'session-optional', async (context) => {
        const caller = this.#admitted(context).principal;
        if (caller) {
          const r = await ops.logout.execute({
            caller,
            work: context.scope.workContext(),
          });
          if (!r.ok) return this.#failure(r.error);
        }
        const fresh = this.#freshCsrf(ANONYMOUS);
        if (!fresh.ok) return this.#refuse(fresh.error);
        return this.#reply(204, undefined, [
          this.#clearSession(),
          fresh.value.cookie,
        ]);
      }),
      this.#route('POST', 'logout-all', 'session-required', async (context) => {
        const caller = this.#admitted(context).principal!;
        const r = await ops.logoutAll.execute({
          caller,
          work: context.scope.workContext(),
        });
        if (!r.ok) return this.#failure(r.error);
        return this.#reply(204, undefined, [
          this.#clearSession(),
          this.#clearCsrf(),
        ]);
      }),
      this.#route(
        'POST',
        'password/change',
        'session-required',
        async (context) => {
          const body = stringFields(context.request.body, [
            'current_password',
            'new_password',
          ]);
          if (!body.ok) return this.#refuse(body.error);
          const caller = this.#admitted(context).principal!;
          const r = await ops.changePassword.execute({
            caller,
            currentPassword: new SecretString(body.value.current_password),
            newPassword: new SecretString(body.value.new_password),
            source: context.request.source,
            work: context.scope.workContext(),
          });
          if (!r.ok) return this.#failure(r.error);
          return this.#reply(204, undefined, [
            this.#clearSession(),
            this.#clearCsrf(),
          ]);
        },
      ),
      this.#route(
        'POST',
        'password/reset-requests',
        'anonymous',
        async (context) => {
          const body = stringFields(context.request.body, ['email']);
          if (!body.ok) return this.#refuse(body.error);
          const r = await ops.requestReset.execute({
            email: body.value.email,
            source: context.request.source,
            work: context.scope.workContext(),
          });
          return r.ok ? this.#reply(202, accepted) : this.#failure(r.error);
        },
      ),
      this.#route('POST', 'password/reset', 'anonymous', async (context) => {
        const body = stringFields(context.request.body, ['token', 'password']);
        if (!body.ok) return this.#refuse(body.error);
        const r = await ops.resetPassword.execute({
          token: new SecretString(body.value.token),
          newPassword: new SecretString(body.value.password),
          source: context.request.source,
          work: context.scope.workContext(),
        });
        return r.ok ? this.#reply(204, undefined) : this.#failure(r.error);
      }),
    ];
  }
  requireSession(): SessionAdmission {
    return this.#admission('session-required', false);
  }
  requireSessionPost(): SessionAdmission {
    return this.#admission('session-required', true);
  }
}
export function createTransport(
  config: TransportConfig,
  deps: TransportDeps,
): Result<Transport, Failure> {
  const c = validateTransportConfig(config);
  if (!c.ok) return c;
  if (
    !deps ||
    !deps.keyed ||
    typeof deps.entropy !== 'function' ||
    !deps.clock ||
    !deps.digester ||
    !deps.upgradeConsumer ||
    !deps.operations
  )
    return err(configuration());
  const identity = new IdentityTransport(c.value, deps);
  return ok(
    Object.freeze({
      routes: Object.freeze(identity.routes()),
      requireSession: identity.requireSession(),
      requireSessionPost: identity.requireSessionPost(),
      authorizeWebSocket: (request) => identity.authorizeWebSocket(request),
      revalidateWebSocket: (admitted) => identity.revalidateWebSocket(admitted),
    }),
  );
}
