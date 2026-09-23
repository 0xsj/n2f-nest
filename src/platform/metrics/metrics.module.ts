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
  {
    name: 'n2f_event_deliveries_total',
    help: 'Event delivery attempts by consumer and outcome (processed, retrying, dead).',
    type: 'counter' as const,
    labels: ['consumer', 'outcome'],
  },
  {
    name: 'n2f_event_inbox_backlog',
    help: 'Event deliveries not yet processed, by consumer and state (pending, dead).',
    type: 'gauge' as const,
    labels: ['consumer', 'state'],
  },
  {
    name: 'n2f_event_outbox_rows',
    help: 'Outbox rows awaiting publication or dead-lettered, by state.',
    type: 'gauge' as const,
    labels: ['state'],
  },
  {
    name: 'n2f_event_outbox_oldest_pending_seconds',
    help: 'Age of the oldest outbox row awaiting publication; outbox lag.',
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
