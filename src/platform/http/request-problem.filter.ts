import {
  Catch,
  type ArgumentsHost,
  HttpException,
  type ExceptionFilter,
  Injectable,
  Logger,
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

/** Errors raised by the JSON body parser before any controller runs. */
const BODY_ERRORS: Readonly<Record<string, readonly [number, string, string]>> = {
  'entity.too.large': [413, 'Payload Too Large', 'http.body_too_large'],
  'entity.parse.failed': [400, 'Bad Request', 'http.invalid_json'],
  'entity.verify.failed': [400, 'Bad Request', 'http.invalid_json'],
  'request.aborted': [400, 'Bad Request', 'http.request_aborted'],
  'encoding.unsupported': [415, 'Unsupported Media Type', 'http.unsupported_encoding'],
  'charset.unsupported': [415, 'Unsupported Media Type', 'http.unsupported_charset'],
};

const TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

const FRAMEWORK_CODES: Readonly<Record<number, string>> = {
  400: 'http.bad_request',
  404: 'http.not_found',
  405: 'http.method_not_allowed',
  415: 'http.unsupported_media_type',
};

function problem(
  status: number,
  title: string,
  code: string | undefined,
  correlation: Readonly<{ request_id?: string }>,
) {
  const kind = status === 404 ? 'not_found' : status < 500 ? 'invalid' : 'internal';
  return {
    type: `urn:n2f:problem:${kind}`,
    title,
    detail: status >= 500 ? 'internal error' : 'request was refused',
    kind,
    status,
    ...(code ? { code } : {}),
    ...correlation,
  };
}

function isProblem(body: ObjectResponse): boolean {
  return typeof body.type === 'string' && body.type.startsWith('urn:n2f:problem:');
}

/** The body-parser error type, whether thrown directly or wrapped by the framework. */
function bodyErrorType(exception: unknown): string | undefined {
  for (const candidate of [exception, (exception as { cause?: unknown } | null)?.cause]) {
    const type = (candidate as { type?: unknown } | null)?.type;
    if (typeof type === 'string' && type in BODY_ERRORS) return type;
  }
  return undefined;
}

/**
 * Every error leaves as a problem response carrying the request ID. Framework
 * exceptions keep their body; body-parser errors map to fixed problems; any
 * other error is an opaque 500, so no message, stack or driver text reaches a
 * client.
 */
@Injectable()
@Catch()
export class RequestProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('RequestProblemFilter');

  constructor(private readonly context: RequestContext) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    // A handler may have set another content type before failing.
    response.type('application/json');
    const requestId = this.context.requestId();
    const correlation = requestId ? { request_id: requestId } : {};

    const bodyType = bodyErrorType(exception);
    const known = bodyType ? BODY_ERRORS[bodyType] : undefined;
    if (known) {
      const [status, title, code] = known;
      response.status(status).json(problem(status, title, code, correlation));
      return;
    }

    if (exception instanceof HttpException) {
      const body = objectResponse(exception.getResponse());
      const status = exception.getStatus();
      // Problems built by this application pass through; anything the
      // framework generated is replaced, so its message never reaches a client.
      response
        .status(status)
        .json(
          isProblem(body)
            ? { ...body, ...correlation }
            : problem(status, TITLES[status] ?? 'Error', FRAMEWORK_CODES[status] ?? 'http.error', correlation),
        );
      return;
    }

    this.logger.error(
      `unhandled ${exception instanceof Error ? exception.name : typeof exception}` +
        (requestId ? ` request_id=${requestId}` : ''),
    );
    response.status(500).json(problem(500, 'Internal Server Error', undefined, correlation));
  }
}
