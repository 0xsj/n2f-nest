/** One bounded attempt; received HTTP refusals remain transport responses. */
import http from 'node:http';
import https from 'node:https';
import {
  err,
  failure,
  ok,
  type Failure,
  type Kind,
  type Result,
} from '../errors/index.js';
import { SecretString } from '../secret/index.js';
import { snapshot, type TraceRef } from '../telemetry/index.js';

export type Config = {
  origin: string;
  timeoutMs: number;
  maxRequest: number;
  maxResponse: number;
  bearer?: SecretString;
};

export type Request = {
  method: string;
  path: string;
  body?: Uint8Array;
  trace?: TraceRef;
};

export type Response = {
  status: number;
  body: Uint8Array;
  contentType: string;
};

const fail = (kind: Kind, code: string) =>
  failure(kind, 'outbound HTTP operation failed', {
    type: 'httpclient.' + code,
  });

export class Client {
  #closed = false;
  #active = new Set<AbortController>();

  private constructor(
    private readonly config: Config,
    private readonly base: URL,
  ) {}

  static create(config: Config): Result<Client, Failure> {
    try {
      const origin = new URL(config.origin);
      if (
        !['http:', 'https:'].includes(origin.protocol) ||
        origin.username ||
        origin.password ||
        origin.search ||
        origin.hash ||
        origin.pathname !== '/' ||
        ![config.timeoutMs, config.maxRequest, config.maxResponse].every(
          Number.isInteger,
        ) ||
        config.timeoutMs < 1 ||
        config.timeoutMs > 30000 ||
        config.maxRequest < 1 ||
        config.maxRequest > 1048576 ||
        config.maxResponse < 1 ||
        config.maxResponse > 1048576 ||
        /[\r\n]/.test(config.bearer?.reveal() ?? '')
      ) {
        return err(fail('invalid', 'config'));
      }
      return ok(new Client({ ...config }, origin));
    } catch {
      return err(fail('invalid', 'config'));
    }
  }

  async do(
    input: Request,
    signal?: AbortSignal,
  ): Promise<Result<Response, Failure>> {
    if (this.#closed) return err(fail('unavailable', 'closed'));
    if (this.#active.size >= 64) return err(fail('rate_limited', 'busy'));
    if (signal?.aborted) return err(fail('canceled', 'canceled'));
    if (
      !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(
        input.method,
      ) ||
      !input.path.startsWith('/') ||
      input.path.startsWith('//') ||
      /[\\\r\n#]/.test(input.path) ||
      (input.body?.byteLength ?? 0) > this.config.maxRequest
    ) {
      return err(fail('invalid', 'request'));
    }

    let target: URL;
    try {
      target = new URL(input.path, this.base);
      if (target.origin !== this.base.origin) {
        return err(fail('invalid', 'request'));
      }
    } catch {
      return err(fail('invalid', 'request'));
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
    };
    if (this.config.bearer?.reveal()) {
      headers.authorization = 'Bearer ' + this.config.bearer.reveal();
    }
    if (input.trace) {
      try {
        const trace = snapshot(input.trace);
        headers.traceparent =
          '00-' +
          trace.traceId +
          '-' +
          trace.spanId +
          '-' +
          (trace.sampled ? '01' : '00');
      } catch {
        return err(fail('invalid', 'trace'));
      }
    }

    const body = Buffer.from(input.body ?? []);
    headers['content-length'] = String(body.byteLength);
    const controller = new AbortController();
    this.#active.add(controller);
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.timeoutMs);

    try {
      return await new Promise<Result<Response, Failure>>((resolve) => {
        let request: http.ClientRequest;
        try {
          request = (target.protocol === 'https:' ? https : http).request(
            target,
            {
              method: input.method,
              headers,
              agent: false,
              maxHeaderSize: 16384,
              signal: controller.signal,
            },
            (response) => {
              const chunks: Buffer[] = [];
              let size = 0;
              response.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > this.config.maxResponse) {
                  resolve(err(fail('unavailable', 'response_too_large')));
                  response.destroy();
                  request.destroy();
                } else {
                  chunks.push(chunk);
                }
              });
              response.on('error', () =>
                resolve(
                  err(
                    fail(
                      timedOut
                        ? 'timeout'
                        : controller.signal.aborted
                          ? 'canceled'
                          : 'unavailable',
                      timedOut
                        ? 'timeout'
                        : controller.signal.aborted
                          ? 'canceled'
                          : 'network',
                    ),
                  ),
                ),
              );
              response.on('end', () => {
                const status = response.statusCode ?? 0;
                if (status < 200 || status > 599 || !response.complete) {
                  resolve(err(fail('unavailable', 'protocol')));
                } else {
                  resolve(
                    ok({
                      status,
                      body: Buffer.concat(chunks),
                      contentType: response.headers['content-type'] ?? '',
                    }),
                  );
                }
              });
            },
          );
        } catch {
          resolve(err(fail('invalid', 'request')));
          return;
        }
        request.on('error', () =>
          resolve(
            err(
              fail(
                timedOut
                  ? 'timeout'
                  : controller.signal.aborted
                    ? 'canceled'
                    : 'unavailable',
                timedOut
                  ? 'timeout'
                  : controller.signal.aborted
                    ? 'canceled'
                    : 'network',
              ),
            ),
          ),
        );
        request.end(body);
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      this.#active.delete(controller);
    }
  }

  close(): void {
    this.#closed = true;
    for (const controller of this.#active) controller.abort();
  }
}
