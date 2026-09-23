import { createHash, timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Get,
  Headers,
  HttpException,
  Inject,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { MetricsRegistry } from '../../shared/metrics/index.js';
import { RUNTIME_CONFIG } from '../runtime/tokens.js';
import type { RuntimeConfig } from '../runtime/config.js';
import { METRICS } from './metrics.tokens.js';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Prometheus metrics reveal traffic, failure and backlog patterns, so a
 * configured `N2F_METRICS_TOKEN` must accompany every scrape as a bearer
 * token. Production refuses to start without one; development without one
 * serves metrics openly.
 */
@Controller()
export class MetricsController {
  constructor(
    @Inject(METRICS) private readonly metrics: MetricsRegistry,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  @Get('metrics')
  read(
    @Res({ passthrough: true }) response: Response,
    @Headers('authorization') authorization?: string,
  ): string {
    const expected = this.config.metricsToken?.reveal();
    if (expected !== undefined) {
      const presented = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1] ?? '';
      // Compare fixed-length digests so neither length nor content leaks by timing.
      if (!timingSafeEqual(digest(presented), digest(expected))) {
        throw new HttpException(
          {
            type: 'urn:n2f:problem:unauthenticated',
            title: 'Unauthorized',
            detail: 'metrics require a bearer token',
            kind: 'unauthenticated',
            status: 401,
            code: 'metrics.unauthenticated',
          },
          401,
        );
      }
    }
    response.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return this.metrics.renderPrometheus();
  }
}
