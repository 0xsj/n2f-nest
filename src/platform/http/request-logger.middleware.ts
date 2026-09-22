import {
  Inject,
  Injectable,
  Logger,
  type NestMiddleware,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { parse, type ID } from '../../shared/id/index.js';
import {
  formatTraceparent,
  parseTraceparent,
  snapshot,
  traceRef,
  type TraceRef,
} from '../../shared/telemetry/index.js';
import { classifyCompletion } from '../../shared/http/index.js';
import { MetricsRegistry } from '../../shared/metrics/index.js';
import { METRICS } from '../metrics/metrics.tokens.js';
import { RequestContext } from './request-context.js';

function requestId(value: string | undefined): ID {
  const parsed = parse(value);
  if (parsed.ok) return parsed.value;

  const generated = parse(randomUUID());
  if (!generated.ok) throw new Error('generated request ID was invalid');
  return generated.value;
}

function requestTrace(value: string | undefined): TraceRef {
  const incoming = parseTraceparent(value);
  const parent = incoming.ok ? snapshot(incoming.value) : undefined;
  const created = traceRef(
    parent?.traceId ?? randomBytes(16).toString('hex'),
    randomBytes(8).toString('hex'),
    parent?.sampled ?? true,
  );
  if (!created.ok) throw new Error('generated trace context was invalid');
  return created.value;
}

/** Logs request completion without inspecting bodies, cookies or credentials. */
@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  constructor(
    private readonly context: RequestContext,
    @Inject(METRICS) private readonly metrics: MetricsRegistry,
  ) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const started = process.hrtime.bigint();
    const id = requestId(request.header('x-request-id'));
    const trace = requestTrace(request.header('traceparent'));
    let completed = false;
    this.metrics.add('n2f_http_active_requests', {}, 1);

    response.setHeader('x-request-id', id);
    response.setHeader('traceparent', formatTraceparent(trace));

    const finish = (termination: 'completed' | 'closed'): void => {
      if (completed) return;
      completed = true;
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      const status = response.statusCode;
      const facts =
        termination === 'completed'
          ? { status, termination: 'response_completed' as const }
          : { termination: 'peer_closed' as const };
      const classification = classifyCompletion(facts);
      const outcome = classification.ok ? classification.value.outcome : 'failed';
      const route =
        typeof request.route?.path === 'string' ? request.route.path : 'unmatched';
      this.metrics.add('n2f_http_active_requests', {}, -1);
      this.metrics.add(
        'n2f_http_requests_total',
        {
          method: request.method,
          route,
          status: String(status),
          outcome,
        },
        1,
      );
      this.metrics.observe(
        'n2f_http_request_duration_seconds',
        { method: request.method, route },
        durationMs / 1000,
      );
      this.logger.log(
        `${request.method} ${request.path} ${status} ${durationMs.toFixed(1)}ms ` +
          `termination=${termination} request_id=${id} ` +
          `trace_id=${snapshot(trace).traceId} span_id=${snapshot(trace).spanId}`,
      );
    };

    response.once('finish', () => finish('completed'));
    response.once('close', () => finish('closed'));
    this.context.run(id, trace, next);
  }
}
