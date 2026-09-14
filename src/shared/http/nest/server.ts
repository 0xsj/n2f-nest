import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingHttpHeaders } from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import { Active } from '../lifecycle.js';
import { normalizeMethod, type Termination } from '../policy.js';
import { problemOf } from '../problem.js';
import {
  allowFor,
  parseCookies,
  Refuse,
  Reply,
  SELECTED_HEADERS,
  type Admission,
  type FeatureRequest,
  type Method,
  type SelectedHeader,
} from '../feature.js';
import {
  failure,
  err,
  ok,
  kindOf,
  type Result,
  type Failure,
} from '../../errors/index.js';
import {
  anonymous,
  attribution,
  inspectIncoming,
  type Attribution,
  type IncomingResult,
  type Scope,
} from '../../provenance/index.js';
import type { Logger } from '../../logger/index.js';
import type { Observer } from './observer.js';
export interface RequestContext {
  readonly scope: Scope;
  readonly log: Logger;
  readonly signal: AbortSignal;
  readonly request: FeatureRequest;
}
export interface Route {
  readonly path: string;
  readonly operation: string;
  /** Defaults to GET; HEAD is served for every GET route without a body (H15). */
  readonly method?: Method;
  /** Runs after routing and before the scope opens, at most once (H17). */
  readonly admission?: (
    request: FeatureRequest,
    signal: AbortSignal,
  ) => Promise<Result<Admission, unknown>> | Result<Admission, unknown>;
  readonly handler: (
    context: RequestContext,
  ) => Promise<Result<unknown, unknown>> | Result<unknown, unknown>;
}
interface State {
  active: Active;
  log: Logger;
  scope?: Scope;
  selected?: { error: unknown };
  refusal?: Refuse;
  methods?: ReadonlyMap<Method, Route>;
  template?: string;
  route?: Route;
  termination: Termination;
  abort: AbortController;
}
export interface Config {
  routes: readonly Route[];
  observer: Observer;
  log: Logger;
  /** Receives the admitted attribution: anonymous unless admission established an initiator. */
  open: (
    operation: string,
    incoming: IncomingResult,
    attribution: Attribution,
  ) => Result<Scope, Failure>;
  /** Trusted source key; the default is the peer address, never a forwarding header. */
  source?: (
    remoteAddress: string | undefined,
    headers: IncomingHttpHeaders,
  ) => string;
  now: () => bigint;
  timeoutMs: number;
  maxBody: number;
  maxActive: number;
}
const anonymousAttribution = (): Attribution => {
  const at = attribution({ initiator: anonymous() });
  if (!at.ok) throw new Error('anonymous attribution');
  return at.value;
};
export class Server {
  readonly #contexts = new AsyncLocalStorage<RequestContext>();
  readonly #states = new WeakMap<Request, State>();
  readonly #routes = new Map<string, Map<Method, Route>>();
  readonly #workers = new Set<Promise<unknown>>();
  readonly #anonymous = anonymousAttribution();
  constructor(readonly config: Config) {
    if (
      !Number.isInteger(config.timeoutMs) ||
      config.timeoutMs < 1 ||
      config.maxBody < 1 ||
      config.maxActive < 1
    )
      throw new Error('invalid HTTP configuration');
    for (const route of config.routes) {
      const method = route.method ?? 'GET';
      if (normalizeMethod(method) === '_OTHER')
        throw new Error('invalid route method');
      let byMethod = this.#routes.get(route.path);
      if (!byMethod) {
        byMethod = new Map();
        this.#routes.set(route.path, byMethod);
      }
      if (byMethod.has(method)) throw new Error('duplicate route');
      byMethod.set(method, route);
    }
  }
  current(): RequestContext | undefined {
    return this.#contexts.getStore();
  }
  middleware = (req: Request, res: Response, next: NextFunction): void => {
    const method = normalizeMethod(req.method),
      observation = this.config.observer.start(
        method,
        req.secure ? 'https' : 'http',
        req.headers,
      );
    const state: State = {
      log: this.config.log,
      termination: 'response_completed',
      abort: new AbortController(),
      active: undefined as unknown as Active,
    };
    state.active = new Active(this.config.now, [
      (c) => observation.finish(c, state.template, state.scope, state.selected),
      (c) => {
        const fields = {
          method,
          ...(state.template ? { route: state.template } : {}),
          ...(c.facts.status === undefined ? {} : { status: c.facts.status }),
          outcome: c.classification.outcome,
          termination: c.facts.termination,
          elapsed_ms: Number(c.elapsedNs) / 1e6,
        };
        const log = state.selected
          ? state.log.withError(state.selected.error)
          : state.log;
        if (c.classification.outcome === 'failed')
          log.error('http.request.completed', fields);
        else if (['canceled', 'timed_out'].includes(c.classification.outcome))
          log.warn('http.request.completed', fields);
        else log.info('http.request.completed', fields);
      },
    ]);
    this.#states.set(req, state);
    const finish = (closed: boolean) => {
      if (closed && !res.writableFinished) {
        state.termination = 'peer_closed';
        state.abort.abort();
      }
      const kind = state.selected
        ? (kindOf(state.selected.error) ?? 'internal')
        : undefined;
      state.active.finish({
        ...(res.headersSent ? { status: res.statusCode } : {}),
        ...(kind ? { failureKind: kind } : {}),
        termination: state.termination,
      });
    };
    res.once('finish', () => finish(false));
    res.once('close', () => finish(true));
    res.once('error', () => {
      state.termination = 'write_error';
      finish(false);
    });
    state.methods = this.#routes.get(req.path);
    state.template = state.methods ? req.path : undefined;
    state.route =
      state.methods?.get(method as Method) ??
      (method === 'HEAD' ? state.methods?.get('GET') : undefined);
    observation.run(next);
  };
  #values(req: Request, name: string): string[] {
    const values: string[] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      if (req.rawHeaders[i].toLowerCase() === name)
        values.push(req.rawHeaders[i + 1]);
    return values;
  }
  async handle(req: Request, res: Response): Promise<void> {
    const state = this.#states.get(req);
    if (!state) {
      res.status(500).end();
      return;
    }
    let protocol: number | undefined;
    let retryAfter: number | undefined;
    let admitted: unknown;
    let at: Attribution = this.#anonymous;
    let admissionRefused = false;
    if (!state.selected && !state.methods)
      state.selected = {
        error: failure('not_found', 'route not found', {
          type: 'http.not_found',
        }),
      };
    if (!state.selected && !state.route) {
      state.selected = {
        error: failure('invalid', 'method not allowed', {
          type: 'http.method_not_allowed',
        }),
      };
      protocol = 405;
      res.setHeader('Allow', allowFor([...state.methods!.keys()]));
    }
    let result: Result<unknown, unknown> = ok({ ok: true });
    let body: Uint8Array = new Uint8Array(0);
    try {
      if (
        !state.selected &&
        ((req.headers['content-length'] ?? '0') !== '0' ||
          req.headers['transfer-encoding'])
      ) {
        if (
          req.headers['content-type']?.split(';')[0].trim() !==
          'application/json'
        ) {
          state.selected = {
            error: failure('invalid', 'unsupported media type', {
              type: 'http.unsupported_media_type',
            }),
          };
          protocol = 415;
        } else {
          const read = await readBody(req, this.config.maxBody);
          if (typeof read === 'number') {
            protocol = read;
            state.selected = {
              error: failure(
                'invalid',
                read === 408
                  ? 'request body timed out'
                  : read === 413
                    ? 'request body too large'
                    : 'invalid request body',
                {
                  type:
                    read === 408
                      ? 'http.request_timeout'
                      : read === 413
                        ? 'http.body_too_large'
                        : 'http.invalid_body',
                },
              ),
            };
            if (read === 408) state.termination = 'deadline';
            res.setHeader('Connection', 'close');
          } else body = read;
        }
      }
      const headers = {} as Record<SelectedHeader, readonly string[]>;
      for (const name of SELECTED_HEADERS)
        headers[name] = Object.freeze(this.#values(req, name));
      const query = req.originalUrl.includes('?')
        ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1)
        : '';
      const request: FeatureRequest = Object.freeze({
        method: normalizeMethod(req.method),
        template: state.template ?? '',
        body,
        headers: Object.freeze(headers),
        cookies: parseCookies(req.headers.cookie),
        source: (this.config.source ?? defaultSource)(
          req.socket?.remoteAddress,
          req.headers,
        ),
        query,
      });
      if (!state.selected && state.route?.admission) {
        let admission: Result<Admission, unknown>;
        try {
          admission = await state.route.admission(request, state.abort.signal);
        } catch (error) {
          admission = err(error);
        }
        if (!admission.ok) {
          this.#select(state, admission.error);
          admissionRefused = true;
        } else if (admission.value.kind === 'refused') {
          this.#select(state, admission.value.error);
          admissionRefused = true;
          if (
            Number.isInteger(admission.value.retryAfterSeconds) &&
            admission.value.retryAfterSeconds! >= 0
          )
            retryAfter = admission.value.retryAfterSeconds;
        } else if (admission.value.kind === 'authenticated') {
          const established = attribution({
            initiator: admission.value.initiator,
            ...(admission.value.tenant === undefined
              ? {}
              : { tenant: admission.value.tenant }),
          });
          if (!established.ok) state.selected = { error: established.error };
          else {
            at = established.value;
            admitted = admission.value.admitted;
          }
        }
      }
      this.#openScope(state, res, req, at, admissionRefused);
      if (retryAfter !== undefined)
        res.setHeader('Retry-After', String(retryAfter));
      if (!state.selected) {
        if (this.#workers.size >= this.config.maxActive)
          state.selected = {
            error: failure('unavailable', 'server busy', { type: 'http.busy' }),
          };
        else {
          const context: RequestContext = Object.freeze({
            scope: state.scope!,
            log: state.log,
            signal: state.abort.signal,
            request:
              admitted === undefined
                ? request
                : Object.freeze({ ...request, admitted }),
          });
          const work = Promise.resolve()
            .then(() =>
              this.#contexts.run(context, () => state.route!.handler(context)),
            )
            .catch((error) => err(error));
          this.#workers.add(work);
          void work.finally(() => this.#workers.delete(work));
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<Result<unknown, unknown>>((resolve) => {
            timer = setTimeout(() => {
              state.termination = 'deadline';
              state.abort.abort();
              resolve(
                err(
                  failure('timeout', 'request timed out', {
                    type: 'http.timeout',
                  }),
                ),
              );
            }, this.config.timeoutMs);
          });
          try {
            result = await Promise.race([work, timeout]);
          } finally {
            clearTimeout(timer);
          }
          if (!result.ok) this.#select(state, result.error);
        }
      }
      if (res.destroyed) return;
      if (state.selected) {
        const problem = problemOf(err(state.selected.error))!;
        const body = {
          ...problem,
          ...(protocol
            ? {
                status: protocol,
                title:
                  protocol === 405
                    ? 'Method Not Allowed'
                    : protocol === 408
                      ? 'Request Timeout'
                      : protocol === 413
                        ? 'Payload Too Large'
                        : 'Unsupported Media Type',
              }
            : {}),
          ...(state.scope
            ? {
                request_id: state.scope.snapshot().scopeId,
                correlation_id: state.scope.snapshot().work.correlationId,
              }
            : {}),
        };
        if (state.refusal) {
          for (const [name, value] of state.refusal.headers)
            res.setHeader(name, value);
          if (state.refusal.cookies.length)
            res.setHeader('Set-Cookie', [...state.refusal.cookies]);
        }
        res
          .status(body.status)
          .type('application/problem+json')
          .send(JSON.stringify(body));
      } else if (result.ok && result.value instanceof Reply) {
        const reply = result.value;
        for (const [name, value] of reply.headers) res.setHeader(name, value);
        if (reply.cookies.length)
          res.setHeader('Set-Cookie', [...reply.cookies]);
        res.status(reply.status);
        if (reply.body === undefined) res.end();
        else res.type('application/json').send(JSON.stringify(reply.body));
      } else
        res
          .status(200)
          .type('application/json')
          .send(JSON.stringify(result.ok ? result.value : null));
    } catch (error) {
      state.selected = { error };
      if (res.headersSent) {
        state.termination = 'handler_error';
        res.destroy();
        return;
      }
      res
        .status(500)
        .type('application/problem+json')
        .send(JSON.stringify(problemOf(err(error))));
    }
  }
  /** A Refuse contributes its headers and cookies; its inner error is what is classified (H16). */
  #select(state: State, error: unknown): void {
    if (error instanceof Refuse) {
      state.refusal = error;
      state.selected = { error: error.error };
    } else state.selected = { error };
  }
  #openScope(
    state: State,
    res: Response,
    req: Request,
    at: Attribution,
    admissionRefused: boolean,
  ): void {
    const values = this.#values(req, 'x-correlation-id');
    const scope = this.config.open(
      admissionRefused
        ? 'http.admission'
        : (state.route?.operation ?? 'http.unmatched'),
      inspectIncoming(
        values.length
          ? { correlation: values.length === 1 ? values[0] : '' }
          : {},
      ),
      at,
    );
    if (!scope.ok) {
      state.selected ??= { error: scope.error };
      return;
    }
    state.scope = scope.value;
    const bound = state.log.withScope(scope.value);
    if (bound.ok) state.log = bound.value;
    const snap = scope.value.snapshot();
    res.setHeader('X-Request-ID', snap.scopeId);
    res.setHeader('X-Correlation-ID', snap.work.correlationId);
  }
  async drain(remainingMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(this.#workers),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, remainingMs));
      }),
    ]);
    clearTimeout(timer);
  }
}
function defaultSource(remoteAddress: string | undefined): string {
  return remoteAddress ?? '';
}

function readBody(req: Request, max: number): Promise<number | Uint8Array> {
  return new Promise((resolve) => {
    let size = 0,
      done = false;
    const chunks: Buffer[] = [];
    const finish = (status?: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off('data', data);
      req.off('end', end);
      req.off('aborted', aborted);
      if (status) {
        req.pause();
        resolve(status);
      } else resolve(new Uint8Array(Buffer.concat(chunks)));
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) finish(413);
      else chunks.push(chunk);
    };
    const end = () => finish(),
      aborted = () => finish(400);
    const timer = setTimeout(() => finish(408), 1000);
    req.on('data', data);
    req.once('end', end);
    req.once('aborted', aborted);
    req.once('error', () => finish(400));
  });
}
