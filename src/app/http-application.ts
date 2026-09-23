import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../app.module.js';
import type { RuntimeConfig } from '../platform/runtime/index.js';

/** Upper bound on a JSON request body. Every request in this API is small. */
export const BODY_LIMIT = '64kb';

/**
 * The HTTP application exactly as it serves traffic. main.ts and the
 * integration tests both build it here, so tests exercise the production
 * limits, proxy trust and CORS policy.
 */
export async function createHttpApplication(
  config: RuntimeConfig,
  options: Readonly<{ logger?: false }> = {},
): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    ...(options.logger === false ? { logger: false } : {}),
  });
  app.disable('x-powered-by');
  app.set('trust proxy', config.http.trustProxy);
  // JSON only: other content types are never parsed and fail validation.
  app.useBodyParser('json', { limit: BODY_LIMIT });
  if (config.http.corsOrigins.length > 0) {
    app.enableCors({
      origin: [...config.http.corsOrigins],
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'traceparent', 'x-request-id'],
      exposedHeaders: ['x-request-id', 'traceparent', 'Retry-After'],
      credentials: false,
      maxAge: 600,
    });
  }
  return app;
}
