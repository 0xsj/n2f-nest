import {
  Injectable,
  Logger,
  type NestMiddleware,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { parse, type ID } from '../../shared/id/index.js';
import { RequestContext } from './request-context.js';

function requestId(value: string | undefined): ID {
  const parsed = parse(value);
  if (parsed.ok) return parsed.value;

  const generated = parse(randomUUID());
  if (!generated.ok) throw new Error('generated request ID was invalid');
  return generated.value;
}

/** Logs request completion without inspecting bodies, cookies or credentials. */
@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly context: RequestContext) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const started = process.hrtime.bigint();
    const id = requestId(request.header('x-request-id'));
    let completed = false;

    response.setHeader('x-request-id', id);

    const finish = (termination: 'completed' | 'closed'): void => {
      if (completed) return;
      completed = true;
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      const status = response.statusCode;
      this.logger.log(
        `${request.method} ${request.path} ${status} ${durationMs.toFixed(1)}ms ` +
          `termination=${termination} request_id=${id}`,
      );
    };

    response.once('finish', () => finish('completed'));
    response.once('close', () => finish('closed'));
    this.context.run(id, next);
  }
}
