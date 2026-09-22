import { Global, Module } from '@nestjs/common';
import { MetricsRegistry } from '../../shared/metrics/index.js';
import { MetricsController } from './metrics.controller.js';
import { METRICS } from './metrics.tokens.js';

const definitions = [
  {
    name: 'n2f_http_requests_total',
    help: 'Completed HTTP requests.',
    type: 'counter' as const,
    labels: ['method', 'route', 'status', 'outcome'],
  },
  {
    name: 'n2f_http_request_duration_seconds',
    help: 'HTTP request duration in seconds.',
    type: 'histogram' as const,
    labels: ['method', 'route'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  },
  {
    name: 'n2f_http_active_requests',
    help: 'HTTP requests currently in progress.',
    type: 'gauge' as const,
    labels: [],
  },
] as const;

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: METRICS,
      useFactory: (): MetricsRegistry => new MetricsRegistry(definitions),
    },
  ],
  exports: [METRICS],
})
export class PlatformMetricsModule {}
