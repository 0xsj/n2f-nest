import { Controller, Get, Header, Inject } from '@nestjs/common';
import { MetricsRegistry } from '../../shared/metrics/index.js';
import { METRICS } from './metrics.tokens.js';

@Controller()
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: MetricsRegistry) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  read(): string {
    return this.metrics.renderPrometheus();
  }
}
