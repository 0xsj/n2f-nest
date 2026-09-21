import { publicInfo, type Kind, type Result } from '../errors/index.js';

export type Problem = Readonly<{
  type: string;
  title: string;
  detail: string;
  kind: Kind;
  status: number;
  code?: string;
  fields?: Readonly<Record<string, string>>;
  request_id?: string;
  correlation_id?: string;
}>;

export function problemOf(
  result: Result<unknown, unknown>,
): Problem | undefined {
  if (result.ok) return undefined;
  const info = publicInfo(result.error);
  const status = {
    invalid: 400,
    not_found: 404,
    conflict: 409,
    unauthenticated: 401,
    forbidden: 403,
    rate_limited: 429,
    unavailable: 503,
    timeout: 503,
    canceled: 503,
    internal: 500,
  }[info.kind];
  const title: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    429: 'Too Many Requests',
    503: 'Service Unavailable',
    500: 'Internal Server Error',
  };
  return Object.freeze({
    type: 'urn:n2f:problem:' + info.kind,
    title: title[status],
    detail: info.message,
    kind: info.kind,
    status,
    ...(info.type ? { code: info.type } : {}),
    ...(info.fields && Object.keys(info.fields).length
      ? { fields: Object.freeze({ ...info.fields }) }
      : {}),
  });
}
