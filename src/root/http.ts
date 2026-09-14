import { All, Controller, Module, Req, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createServer, type IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { Request, Response } from 'express';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  context as sdkContext,
  trace,
  diag,
  DiagLogLevel,
} from '@opentelemetry/api';
import { Reader, type Lookup } from '../shared/env/index.js';
import { SystemClock } from '../shared/clock/index.js';
import { V7 } from '../shared/id/index.js';
import {
  Factory,
  actor,
  anonymous,
  attribution,
  operation,
  inspectIncoming,
} from '../shared/provenance/index.js';
import {
  failure,
  err,
  ok,
  AppError,
  type Result,
  type Failure,
} from '../shared/errors/index.js';
import {
  Runtime,
  validate,
  type Config as TelemetryConfig,
} from '../shared/telemetry/otel/runtime.js';
import { OTelObserver } from '../shared/http/otel/observer.js';
import { Server, type Route } from '../shared/http/nest/server.js';
import { compose as composeAudit, migration as auditMigration, Runtime as AuditRuntime } from '../modules/audit/index.js';
import { migration as identityMigration } from '../modules/identity/infra/postgres/index.js';
import type { Config as BrokerConfig } from '../shared/events/jetstream/broker.js';
import { loadConfig, type Config } from './config.js';
import { composeAuth, loadAuthConfig, type AuthConfig } from './auth.js';
import { upgradeTicketMigration } from '../modules/identity/infra/postgres/index.js';
import { invitationMigration as orgInvitationMigration, migration as orgMigration } from '../modules/org/infra/postgres/index.js';
import { WebSocketAdmission } from '../modules/identity/transport/http/index.js';
import type { Var } from '../shared/env/index.js';
import { logging } from './logging.js';
import { parseTrustedProxies, trustedSource, type TrustedProxy } from './proxy.js';
import {
  Database,
  type Config as DatabaseConfig,
} from '../shared/postgres/index.js';
import { Gate } from '../shared/health/index.js';
import { Client as NativeClient } from '../shared/httpclient/index.js';
import { Client as ObservedClient } from '../shared/httpclient/otel/client.js';
import { Server as SocketServer } from '../shared/socket/ws/server.js';
function value<T>(r: Result<T, Failure>): T {
  if (!r.ok) throw new AppError(r.error);
  return r.value;
}
export interface HTTPConfig {
  socketOrigin: string;
  outboundOrigin: string;
  database?: DatabaseConfig;
  auth?: AuthConfig;
  /** Every HTTP-process setting by name, secrets redacted (AUTH_BUILD.md). */
  manifest: Var[];
  testRoutes: boolean;
  base: Config;
  host: string;
  port: number;
  timeoutMs: number;
  shutdownMs: number;
  telemetry: TelemetryConfig;
  events: { transport: string; broker?: BrokerConfig; intervalMs: number };
  auditEnabled: boolean;
  auditConsumer: string;
  trustedProxies: readonly TrustedProxy[];
}
export function loadHTTPConfig(lookup: Lookup): Result<HTTPConfig, Failure> {
  const base = loadConfig(lookup);
  if (!base.ok) return base;
  const r = new Reader(lookup);
  const c: HTTPConfig = {
    socketOrigin: r.string('WS_ORIGIN', 'http://localhost:3000'),
    outboundOrigin: r.string('OUTBOUND_ORIGIN', ''),
    testRoutes: r.boolean('HTTP_TEST_ROUTES', false),
    manifest: [],
    base: base.value,
    host: r.string('HTTP_HOST', '127.0.0.1'),
    port: r.int('HTTP_PORT', 7300, 0, 65535),
    timeoutMs: r.int('HTTP_TIMEOUT_MS', 1000, 1, 30000),
    shutdownMs: r.int('SHUTDOWN_MS', 3000, 1, 30000),
    telemetry: {
      mode: r.enumeration('TELEMETRY_MODE', 'none', ['none', 'otlp']),
      endpoint: r.string('TELEMETRY_ENDPOINT', 'http://127.0.0.1:7342'),
      sampling: r.enumeration('TELEMETRY_SAMPLING', 'all', ['all', 'none']),
      queue: r.int('TELEMETRY_QUEUE', 256, 1, 65536),
      batch: r.int('TELEMETRY_BATCH', 64, 1, 65536),
      timeoutMs: r.int('TELEMETRY_TIMEOUT_MS', 500, 1, 10000),
      intervalMs: r.int('TELEMETRY_INTERVAL_MS', 500, 100, 60000),
      resource: {
        'service.name': base.value.resource.name,
        'service.instance.id': 'validation',
      },
    },
    events: { transport: 'postgres', intervalMs: 100 },
    auditEnabled: false,
    auditConsumer: 'audit',
    trustedProxies: [],
  };
  if (r.boolean('DATABASE_ENABLED', false))
    c.database = {
      url: r.secret('DATABASE_URL'),
      maxConnections: r.int('DATABASE_MAX_CONNECTIONS', 8, 1, 64),
      timeoutMs: r.int('DATABASE_TIMEOUT_MS', 1000, 1, 30000),
    };
  if (r.boolean('AUTH_ENABLED', false)) c.auth = loadAuthConfig(r, lookup);
  const eventsTransport = r.enumeration('EVENTS_TRANSPORT', 'postgres', [
    'postgres',
    'jetstream',
  ]);
  const eventsIntervalMs = r.int('EVENTS_INTERVAL_MS', 100, 10, 60000);
  const eventsBroker =
    eventsTransport === 'jetstream'
      ? {
          url: r.secret('NATS_URL'),
          stream: r.string('NATS_STREAM', 'N2F_EVENTS'),
          consumer: r.string('NATS_CONSUMER', 'mailbox'),
          timeoutMs: r.int('NATS_TIMEOUT_MS', 1000, 1, 5000),
        }
      : undefined;
  const auditEnabled = r.boolean('AUDIT_ENABLED', !!c.auth);
  const auditConsumer = r.string('AUDIT_CONSUMER', 'audit');
  const trustedProxies = parseTrustedProxies(
    r.string('HTTP_TRUSTED_PROXIES', ''),
  );
  if (!trustedProxies.ok) return trustedProxies;
  const checked = r.check();
  if (!checked.ok) return checked;
  if (c.auth && !c.database)
    return err(
      failure('invalid', 'AUTH_ENABLED requires DATABASE_ENABLED', {
        type: 'env.invalid',
        fields: { AUTH_ENABLED: 'requires_database' },
      }),
    );
  if (auditEnabled && !c.auth)
    return err(
      failure('invalid', 'AUDIT_ENABLED requires AUTH_ENABLED', {
        type: 'env.invalid',
        fields: { AUDIT_ENABLED: 'requires_auth' },
      }),
    );
  const manifest = r.manifest();
  if (!manifest.ok) return manifest;
  c.manifest = manifest.value;
  if (!isIP(c.host))
    return err(
      failure('invalid', 'invalid HTTP host', { type: 'env.invalid' }),
    );
  const valid = validate(c.telemetry);
  if (!valid.ok) return valid;
  c.events = {
    transport: eventsTransport,
    ...(eventsBroker ? { broker: eventsBroker } : {}),
    intervalMs: eventsIntervalMs,
  };
  c.auditEnabled = auditEnabled;
  c.auditConsumer = auditConsumer;
  c.trustedProxies = trustedProxies.value;
  return ok(c);
}
export async function startHTTP(
  lookup: Lookup,
  diagnostic: (line: string) => void = (s) => {
    process.stderr.write(s);
  },
) {
  const c = value(loadHTTPConfig(lookup)),
    clock = new SystemClock(),
    ids = new V7(clock);
  c.base.resource = { ...c.base.resource, instance_id: value(ids.newId()) };
  const log = value(
    logging(
      c.base,
      clock,
      {
        write: (line) =>
          new Promise<void>((resolve, reject) => {
            process.stdout.write(line, (error) =>
              error ? reject(error) : resolve(),
            );
          }),
      },
      !!process.stdout.isTTY,
    ),
  );
  let events = 0;
  diag.setLogger(
    {
      error: () => {
        events++;
      },
      warn: () => {
        events++;
      },
      info: () => {},
      debug: () => {},
      verbose: () => {},
    },
    DiagLogLevel.WARN,
  );
  c.telemetry.resource = {
    'service.name': c.base.resource.name,
    'service.namespace': c.base.resource.namespace ?? '',
    'service.version': c.base.resource.version ?? '',
    'service.instance.id': c.base.resource.instance_id!,
    'deployment.environment.name': c.base.resource.environment ?? '',
  };
  const telemetry = new Runtime(c.telemetry),
    contexts =
      c.telemetry.mode === 'otlp'
        ? new AsyncLocalStorageContextManager().enable()
        : undefined;
  if (contexts && !sdkContext.setGlobalContextManager(contexts))
    throw new Error('telemetry context already owned');
  const observer = new OTelObserver(telemetry, contexts);
  const factory = new Factory(clock, ids),
    executor = value(actor('service', c.base.resource.name)),
    at = value(attribution({ initiator: anonymous() }));
  let database: Database | undefined;
  if (c.database) {
    const opened = await Database.open(c.database);
    if (!opened.ok) {
      observer.close();
      await telemetry.close(c.shutdownMs);
      await log.close(c.shutdownMs);
      throw new Error('database startup failed');
    }
    database = opened.value;
  }
  const gate = new Gate(500, database ? [() => database!.ping()] : []);
  let authManifest: Readonly<Record<string, string | number>> = {};
  const authRoutes: Route[] = [];
  let auditRuntime: AuditRuntime | undefined;
  let socketAuthorize: ((request: IncomingMessage) => Promise<Result<unknown, Failure>>) | undefined;
  let socketRevalidate: ((admitted: unknown) => Promise<Result<void, Failure>>) | undefined;
  if (c.auth && database) {
    const composed = await composeAuth(c.auth, {
      database,
      clock,
      ids,
      host: c.host,
      log: log.log,
      ...(c.auditEnabled ? { auditSchema: auditMigration(4) } : {}),
    });
    if (!composed.ok) {
      log.log.withError(composed.error).error('auth.composition_failed');
      await database.close(c.shutdownMs);
      observer.close();
      await telemetry.close(c.shutdownMs);
      await log.close(c.shutdownMs);
      throw new Error('authentication composition failed');
    }
    authRoutes.push(...composed.value.routes);
    socketAuthorize = composed.value.socketAuthorize;
    socketRevalidate = composed.value.socketRevalidate;
    authManifest = composed.value.manifest;
    if (c.auditEnabled) {
      const audit = await composeAudit(
        database,
        { intervalMs: c.events.intervalMs, ...(c.events.broker ? { broker: c.events.broker } : {}) },
        composed.value.requireSession,
        c.auditConsumer,
        clock,
        log.log,
        identityMigration(2),
        upgradeTicketMigration(5),
        orgMigration(6),
        orgInvitationMigration(7),
      );
      if (!audit.ok) {
        log.log.withError(audit.error).error('audit.composition_failed');
        await database.close(c.shutdownMs);
        observer.close();
        await telemetry.close(c.shutdownMs);
        await log.close(c.shutdownMs);
        throw new Error('audit composition failed');
      }
      authRoutes.push(audit.value.route);
      auditRuntime = audit.value.runtime;
    }
  }
  log.log.info('http.manifest', {
    config: c.manifest,
    'auth.enabled': !!c.auth,
    ...(c.auth ? authManifest : {}),
  });
  const outboundNative = c.outboundOrigin
    ? value(
        NativeClient.create({
          origin: c.outboundOrigin,
          timeoutMs: 500,
          maxRequest: 65536,
          maxResponse: 65536,
        }),
      )
    : undefined;
  const outbound = outboundNative
    ? new ObservedClient(outboundNative, telemetry)
    : undefined;
  const routes: Route[] = [
    {
      path: '/_examples/outbound',
      operation: 'http.example.outbound',
      handler: async (context) => {
        if (!outbound)
          return err(failure('unavailable', 'outbound not configured'));
        const r = await outbound.do(
          { method: 'GET', path: '/probe' },
          context.signal,
        );
        return r.ok
          ? ok({ status: r.value.status, body_bytes: r.value.body.byteLength })
          : r;
      },
    },
    {
      path: '/livez',
      operation: 'health.live',
      handler: () => ok({ status: 'alive' }),
    },
    {
      path: '/readyz',
      operation: 'health.ready',
      handler: async (context) =>
        (await gate.ready(context.signal))
          ? ok({ status: 'ready' })
          : err(
              failure('unavailable', 'not ready', { type: 'health.not_ready' }),
            ),
    },
    {
      path: '/_examples/http/success',
      operation: 'http.example.success',
      handler: () => ok({ ok: true }),
    },
    {
      path: '/_examples/http/conflict',
      operation: 'http.example.conflict',
      handler: () =>
        err(
          failure('conflict', 'item already exists', { type: 'demo.exists' }),
        ),
    },
    {
      path: '/_examples/http/unavailable',
      operation: 'http.example.unavailable',
      handler: () =>
        err(
          failure('unavailable', 'dependency unavailable', {
            type: 'demo.offline',
          }),
        ),
    },
    {
      path: '/_examples/http/unknown',
      operation: 'http.example.unknown',
      handler: () => err(new Error('credential-SENTINEL')),
    },
  ];

  if (c.testRoutes)
    routes.push(
      {
        path: '/_examples/http/panic',
        operation: 'http.example.panic',
        handler: () => {
          throw new Error('credential-SENTINEL');
        },
      },
      {
        path: '/_examples/http/delay',
        operation: 'http.example.delay',
        handler: async (context) => {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, c.timeoutMs * 2);
            context.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
          return context.signal.aborted
            ? err(
                failure('timeout', 'request timed out', {
                  type: 'http.timeout',
                }),
              )
            : ok({ ok: true });
        },
      },
      {
        path: '/_examples/http/context',
        operation: 'http.example.context',
        handler: async () => {
          const before = adapter.current()!.scope.snapshot().scopeId;
          const traceBefore = trace.getSpanContext(sdkContext.active())?.spanId;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return ok({
            before,
            after: adapter.current()!.scope.snapshot().scopeId,
            ...(traceBefore
              ? {
                  trace_before: traceBefore,
                  trace_after: trace.getSpanContext(sdkContext.active())
                    ?.spanId,
                }
              : {}),
          });
        },
      },
    );
  routes.push(...authRoutes);
  const adapter = new Server({
    routes,
    observer,
    log: log.log,
    source: (remoteAddress, headers) =>
      trustedSource(c.trustedProxies, remoteAddress, headers),
    now: () => clock.elapsed(),
    timeoutMs: c.timeoutMs,
    maxBody: 1 << 20,
    maxActive: 64,
    open: (name, incoming, admitted) =>
      factory.enter(
        {
          origin: 'request',
          operation: value(operation(name)),
          attribution: admitted,
          executor,
        },
        incoming,
      ),
  });
  @Controller()
  class ExamplesController {
    @All('{*path}')
    handle(@Req() req: Request, @Res() res: Response) {
      return adapter.handle(req, res);
    }
  }
  @Module({ controllers: [ExamplesController] })
  class ExamplesModule {}
  const app = await NestFactory.create(ExamplesModule, {
    logger: false,
    bodyParser: false,
  });
  app.use(adapter.middleware);
  await app.init();
  const server = createServer(
    { maxHeaderSize: 16384, connectionsCheckingInterval: 100 },
    app.getHttpAdapter().getInstance(),
  );
  const sockets = new SocketServer(c.socketOrigin, (admitted) => {
    let socketAt = at;
    if (admitted instanceof WebSocketAdmission) {
      const initiator = actor('user', admitted.principal.principalId);
      if (!initiator.ok) return initiator;
      const attributed = attribution({ initiator: initiator.value });
      if (!attributed.ok) return attributed;
      socketAt = attributed.value;
    }
    const connection = factory.enter(
      {
        origin: 'request',
        operation: value(operation('socket.connection')),
        attribution: socketAt,
        executor,
      },
      inspectIncoming({}),
    );
    if (!connection.ok) return connection;
    const connectionLog = value(log.log.withScope(connection.value));
    connectionLog.info('socket.connection.opened');
    return ok({
      handle: async (message, signal) => {
        if (signal.aborted) return err(failure('canceled', 'message canceled'));
        const scope = factory.child(connection.value, {
          operation: value(operation('socket.message')),
          executor,
        });
        if (!scope.ok) return scope;
        if (message.type !== 'ping')
          return err(failure('invalid', 'unsupported message'));
        value(log.log.withScope(scope.value)).info('socket.message.completed');
        return ok({
          v: 1,
          id: message.id,
          type: 'pong',
          payload: {
            connection_id: connection.value.snapshot().scopeId,
            scope_id: scope.value.snapshot().scopeId,
          },
        });
      },
      close: () => connectionLog.info('socket.connection.closed'),
    });
  }, socketAuthorize, socketRevalidate);
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/_examples/socket') {
      socket.destroy();
      return;
    }
    sockets.upgrade(req, socket, head);
  });
  server.headersTimeout = 1000;
  server.requestTimeout = 0; // The adapter owns a one-second body-read deadline.
  server.keepAliveTimeout = 5000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(c.port, c.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch {
    await auditRuntime?.close(c.shutdownMs);
    await database?.close(c.shutdownMs);
    outboundNative?.close();
    observer.close();
    await telemetry.close(c.shutdownMs);
    await log.close(c.shutdownMs);
    await app.close();
    throw new Error('HTTP startup failed');
  }
  auditRuntime?.start();
  gate.start();
  const address = server.address();
  diagnostic(
    'http.listening ' +
      (typeof address === 'object' && address
        ? c.host + ':' + address.port
        : String(address)) +
      '\n',
  );
  let closing: Promise<void> | undefined;
  return {
    server,
    adapter,
    close: () => {
      if (closing) return closing;
      closing = (async () => {
        gate.drain();
        const deadline = performance.now() + c.shutdownMs,
          remaining = () => Math.max(0, deadline - performance.now());
        const httpClosed = new Promise<void>((resolve) =>
          server.close(() => resolve()),
        );
        if (!(await sockets.close(remaining())))
          diagnostic('socket shutdown incomplete\n');
        const timer = setTimeout(
          () => server.closeAllConnections(),
          remaining(),
        );
        await httpClosed;
        clearTimeout(timer);
        await adapter.drain(remaining());
        outboundNative?.close();
        await auditRuntime?.close(remaining());
        if (database && !(await database.close(remaining())).ok)
          diagnostic('database shutdown incomplete\n');
        const flushed = await telemetry.close(remaining());
        if (!flushed.ok) diagnostic('telemetry shutdown incomplete\n');
        observer.close();
        if (!(await log.close(remaining())).ok)
          diagnostic('logging shutdown incomplete\n');
        await app.close();
        diag.disable();
        if (contexts) sdkContext.disable();
        if (events)
          diagnostic(
            'telemetry diagnostic events=' +
              events +
              '; exact dropped records unknown\n',
          );
      })();
      return closing;
    },
  };
}
