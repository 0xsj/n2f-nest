export type MetricType = 'counter' | 'gauge' | 'histogram';

export type MetricLabels = Readonly<Record<string, string>>;

export type MetricDefinition = Readonly<{
  name: string;
  help: string;
  type: MetricType;
  labels: readonly string[];
  buckets?: readonly number[];
}>;

type HistogramState = Readonly<{
  counts: number[];
  count: number;
  sum: number;
}>;

type Series = {
  readonly definition: MetricDefinition;
  readonly labels: MetricLabels;
  value: number;
  histogram?: HistogramState;
};

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function escapeLabel(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n');
}

function labelsKey(definition: MetricDefinition, labels: MetricLabels): string | undefined {
  const keys = Object.keys(labels);
  if (keys.length !== definition.labels.length) return undefined;

  const values: string[] = [];
  for (const name of definition.labels) {
    const value = labels[name];
    if (typeof value !== 'string') return undefined;
    values.push(value);
  }
  return values.join('\u0001');
}

function labelsText(
  definition: MetricDefinition,
  labels: MetricLabels,
  extra?: readonly [string, string],
): string {
  const values = definition.labels.map(
    (name) => `${name}="${escapeLabel(labels[name] ?? '')}"`,
  );
  if (extra) values.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
  return values.length === 0 ? '' : `{${values.join(',')}}`;
}

function validBuckets(buckets: readonly number[] | undefined): readonly number[] {
  const values = [...(buckets ?? [])]
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  return [...new Set(values)];
}

/**
 * A bounded, process-local metrics registry.
 *
 * It intentionally has no transport or SDK dependency. The platform can
 * render the snapshot for Prometheus today, while another adapter can consume
 * the same observation seam later.
 */
export class MetricsRegistry {
  readonly #definitions = new Map<string, MetricDefinition>();
  readonly #series = new Map<string, Series>();

  constructor(definitions: readonly MetricDefinition[]) {
    for (const definition of definitions) {
      if (
        !METRIC_NAME.test(definition.name) ||
        !definition.help ||
        !definition.labels.every((label) => METRIC_NAME.test(label))
      ) {
        continue;
      }
      this.#definitions.set(definition.name, {
        ...definition,
        labels: [...definition.labels],
        ...(definition.type === 'histogram'
          ? { buckets: validBuckets(definition.buckets) }
          : {}),
      });
    }
  }

  add(name: string, labels: MetricLabels, amount: number): void {
    if (!Number.isFinite(amount)) return;
    const series = this.series(name, labels);
    if (!series || series.definition.type === 'histogram') return;
    series.value += amount;
    if (series.definition.type === 'counter' && series.value < 0) {
      series.value = 0;
    }
  }

  set(name: string, labels: MetricLabels, value: number): void {
    if (!Number.isFinite(value)) return;
    const series = this.series(name, labels);
    if (!series || series.definition.type !== 'gauge') return;
    series.value = value;
  }

  observe(name: string, labels: MetricLabels, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const series = this.series(name, labels);
    if (!series || series.definition.type !== 'histogram') return;

    const buckets = series.definition.buckets ?? [];
    const current = series.histogram ?? {
      counts: buckets.map(() => 0),
      count: 0,
      sum: 0,
    };
    const counts = current.counts.map((count, index) =>
      value <= buckets[index] ? count + 1 : count,
    );
    series.histogram = {
      counts,
      count: current.count + 1,
      sum: current.sum + value,
    };
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    const series = [...this.#series.values()].sort((left, right) =>
      left.definition.name.localeCompare(right.definition.name),
    );
    let previous: string | undefined;

    for (const item of series) {
      if (item.definition.name !== previous) {
        lines.push(`# HELP ${item.definition.name} ${item.definition.help}`);
        lines.push(`# TYPE ${item.definition.name} ${item.definition.type}`);
        previous = item.definition.name;
      }

      if (item.definition.type === 'histogram') {
        const histogram = item.histogram;
        if (!histogram) continue;
        const buckets = item.definition.buckets ?? [];
        buckets.forEach((bucket, index) => {
          lines.push(
            `${item.definition.name}_bucket${labelsText(item.definition, item.labels, ['le', String(bucket)])} ${histogram.counts[index]}`,
          );
        });
        lines.push(
          `${item.definition.name}_bucket${labelsText(item.definition, item.labels, ['le', '+Inf'])} ${histogram.count}`,
        );
        lines.push(
          `${item.definition.name}_sum${labelsText(item.definition, item.labels)} ${histogram.sum}`,
        );
        lines.push(
          `${item.definition.name}_count${labelsText(item.definition, item.labels)} ${histogram.count}`,
        );
        continue;
      }

      lines.push(
        `${item.definition.name}${labelsText(item.definition, item.labels)} ${item.value}`,
      );
    }

    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }

  private series(name: string, labels: MetricLabels): Series | undefined {
    const definition = this.#definitions.get(name);
    if (!definition) return undefined;
    const key = labelsKey(definition, labels);
    if (key === undefined) return undefined;

    const seriesKey = `${name}\u0000${key}`;
    const existing = this.#series.get(seriesKey);
    if (existing) return existing;

    const created: Series = {
      definition,
      labels: Object.freeze({ ...labels }),
      value: 0,
    };
    this.#series.set(seriesKey, created);
    return created;
  }
}
