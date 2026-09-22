import {
  Catch,
  type ArgumentsHost,
  HttpException,
  type ExceptionFilter,
  Injectable,
} from '@nestjs/common';
import type { Response } from 'express';
import { RequestContext } from './request-context.js';

type ObjectResponse = Record<string, unknown>;

function objectResponse(value: unknown): ObjectResponse {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as ObjectResponse) };
  }
  return { message: value };
}

/** Adds transport correlation without changing the domain failure contract. */
@Injectable()
@Catch(HttpException)
export class RequestProblemFilter implements ExceptionFilter<HttpException> {
  constructor(private readonly context: RequestContext) {}

  catch(exception: HttpException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const requestId = this.context.requestId();
    response.status(exception.getStatus()).json({
      ...objectResponse(exception.getResponse()),
      ...(requestId ? { request_id: requestId } : {}),
    });
  }
}
