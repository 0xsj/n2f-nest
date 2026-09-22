import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from './index.js';

const registry = () =>
  new MetricsRegistry([
    {
      name: 'example_requests_total',
      help: 'Example requests.',
      type: 'counter',
      labels: ['method'],
    },
    {
      name: 'example_active',
      help: 'Active examples.',
      type: 'gauge',
      labels: [],
    },
    {
      name: 'example_duration_seconds',
      help: 'Example duration.',
      type: 'histogram',
      labels: ['method'],
      buckets: [0.1, 0.5, 1],
    },
  ]);

describe('MetricsRegistry', () => {
  it('renders counters and gauges with escaped labels', () => {
    const metrics = registry();
    metrics.add('example_requests_total', { method: 'GET"' }, 2);
    metrics.add('example_active', {}, 1);

    expect(metrics.renderPrometheus()).toContain(
      'example_requests_total{method="GET\\""} 2',
    );
    expect(metrics.renderPrometheus()).toContain('example_active 1');
  });

  it('renders cumulative histogram buckets and totals', () => {
    const metrics = registry();
    metrics.observe('example_duration_seconds', { method: 'GET' }, 0.2);
    metrics.observe('example_duration_seconds', { method: 'GET' }, 0.8);

    const output = metrics.renderPrometheus();
    expect(output).toContain('example_duration_seconds_bucket{method="GET",le="0.1"} 0');
    expect(output).toContain('example_duration_seconds_bucket{method="GET",le="0.5"} 1');
    expect(output).toContain('example_duration_seconds_bucket{method="GET",le="+Inf"} 2');
    expect(output).toContain('example_duration_seconds_sum{method="GET"} 1');
    expect(output).toContain('example_duration_seconds_count{method="GET"} 2');
  });

  it('ignores undeclared labels and invalid observations', () => {
    const metrics = registry();
    metrics.add('example_requests_total', { route: '/unexpected' }, 1);
    metrics.observe('example_duration_seconds', { method: 'GET' }, -1);

    expect(metrics.renderPrometheus()).toBe('');
  });
});
