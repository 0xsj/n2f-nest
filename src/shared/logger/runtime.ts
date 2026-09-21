import pino from 'pino';
import {
  snapshot as traceSnapshot,
  type TraceRef,
} from '../telemetry/index.js';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';
import type { Scope } from '../provenance/index.js';
import { normalizedTime } from '../provenance/scope.js';
import {
  colorEnabled,
  invalid,
  parseLevel,
  rank,
  type Config,
  type Level,
} from './config.js';
import { Delivery, type Stats } from './delivery.js';
import { errorProjection, scopeProjection } from './projection.js';
import { snapshot, type Fields } from './fields.js';

type RecordValue = {
  timestamp_ms: number;
  level: Level;
  message: string;
  service: unknown;
  fields: unknown;
  scope?: unknown;
  error?: unknown;
  trace?: unknown;
};

type Emit = (
  level: Level,
  message: string,
  bound: Fields,
  fields: Fields,
  scope: unknown,
  error: unknown,
  bad: boolean,
  trace: unknown,
) => void;

export class Logger {
  readonly #emit: Emit;
  readonly #fields: Fields;
  readonly #scope: unknown;
  readonly #error: unknown;
  readonly #bad: boolean;
  readonly #trace: unknown;

  constructor(
    emit: Emit,
    fields: Fields = {},
    scope?: unknown,
    error?: unknown,
    bad = false,
    trace?: unknown,
  ) {
    this.#emit = emit;
    this.#fields = Object.freeze({ ...fields });
    this.#scope = scope;
    this.#error = error;
    this.#bad = bad;
    this.#trace = trace;
    Object.freeze(this);
  }

  with(fields: Fields): Logger {
    try {
      return new Logger(
        this.#emit,
        { ...this.#fields, ...(snapshot(fields) as Fields) },
        this.#scope,
        this.#error,
        this.#bad,
        this.#trace,
      );
    } catch {
      return new Logger(
        this.#emit,
        this.#fields,
        this.#scope,
        this.#error,
        true,
        this.#trace,
      );
    }
  }

  withScope(scope: Scope): Result<Logger, Failure> {
    const projected = scopeProjection(scope);
    return projected.ok
      ? ok(
          new Logger(
            this.#emit,
            this.#fields,
            projected.value,
            this.#error,
            this.#bad,
            this.#trace,
          ),
        )
      : projected;
  }

  withTrace(ref: TraceRef): Result<Logger, Failure> {
    try {
      const value = traceSnapshot(ref);
      return ok(
        new Logger(
          this.#emit,
          this.#fields,
          this.#scope,
          this.#error,
          this.#bad,
          Object.freeze({
            trace_id: value.traceId,
            span_id: value.spanId,
            sampled: value.sampled,
          }),
        ),
      );
    } catch {
      return err(
        failure('invalid', 'invalid telemetry context', {
          type: 'telemetry.invalid_context',
        }),
      );
    }
  }

  withError(error: unknown): Logger {
    return new Logger(
      this.#emit,
      this.#fields,
      this.#scope,
      errorProjection(error),
      this.#bad,
      this.#trace,
    );
  }

  debug(message: string, fields: Fields = {}): void {
    this.#emit(
      'debug',
      message,
      this.#fields,
      fields,
      this.#scope,
      this.#error,
      this.#bad,
      this.#trace,
    );
  }

  info(message: string, fields: Fields = {}): void {
    this.#emit(
      'info',
      message,
      this.#fields,
      fields,
      this.#scope,
      this.#error,
      this.#bad,
      this.#trace,
    );
  }

  warn(message: string, fields: Fields = {}): void {
    this.#emit(
      'warn',
      message,
      this.#fields,
      fields,
      this.#scope,
      this.#error,
      this.#bad,
      this.#trace,
    );
  }

  error(message: string, fields: Fields = {}): void {
    this.#emit(
      'error',
      message,
      this.#fields,
      fields,
      this.#scope,
      this.#error,
      this.#bad,
      this.#trace,
    );
  }
}

export interface Runtime {
  log: Logger;
  stats(): Stats;
  close(timeoutMs: number): Promise<Result<void, Failure>>;
}

const escape = (value: string): string =>
  consoleControls(JSON.stringify(value).slice(1, -1));

function consoleControls(value: string): string {
  return value.replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (character) =>
      '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

function utcTime(milliseconds: number): string {
  return (
    [
      Math.floor(milliseconds / 3600000) % 24,
      Math.floor(milliseconds / 60000) % 60,
      Math.floor(milliseconds / 1000) % 60,
    ]
      .map((value) => String(value).padStart(2, '0'))
      .join(':') +
    '.' +
    String(milliseconds % 1000).padStart(3, '0')
  );
}

function consoleLine(record: RecordValue, color: boolean): string {
  let severity = record.level.toUpperCase();
  if (color) {
    severity = `\x1b[${
      record.level === 'error' ? 31 : record.level === 'warn' ? 33 : 36
    }m${severity}\x1b[0m`;
  }
  const service = record.service as { name: string };
  return `${utcTime(record.timestamp_ms)} ${severity} ${escape(service.name)} ${escape(record.message)} ${consoleControls(
    JSON.stringify({
      fields: record.fields,
      ...(record.scope ? { scope: record.scope } : {}),
      ...(record.error ? { error: record.error } : {}),
      ...(record.trace ? { trace: record.trace } : {}),
    }),
  )}\n`;
}

export function create(config: Config): Result<Runtime, Failure> {
  const format = config.format ?? 'console';
  const level = parseLevel(config.level ?? 'info');
  const color = colorEnabled(
    config.color ?? 'auto',
    config.terminal ?? false,
    config.noColor ?? false,
  );
  const capacity = config.capacity ?? 256;
  const max = config.maxRecordBytes ?? 65536;

  if (
    !['console', 'json', 'none'].includes(format) ||
    !level.ok ||
    !color.ok ||
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    !Number.isSafeInteger(max) ||
    max < 1 ||
    !config.clock ||
    typeof config.clock.now !== 'function' ||
    !config.sink ||
    typeof config.sink.write !== 'function' ||
    !config.resource?.name
  ) {
    return err(invalid());
  }

  let resource: unknown;
  try {
    resource = snapshot(config.resource);
  } catch {
    return err(invalid());
  }

  const output = new Delivery(config.sink, capacity, max, format === 'none');
  const native =
    format === 'json'
      ? pino(
          {
            level: 'debug',
            base: null,
            timestamp: false,
            messageKey: 'message',
            formatters: { level: (label) => ({ level: label }) },
          },
          { write: (line) => output.write(line) },
        )
      : undefined;

  const emit: Emit = (
    severity,
    message,
    bound,
    extra,
    scope,
    error,
    bad,
    trace,
  ) => {
    if (format === 'none' || rank[severity] < rank[level.value]) return;
    if (output.closed) {
      output.counts.dropped += 1;
      return;
    }

    try {
      if (bad) throw new TypeError('unsupported log field');
      const milliseconds = normalizedTime(config.clock.now());
      if (milliseconds === undefined) throw new TypeError('invalid log time');
      const record: RecordValue = {
        timestamp_ms: milliseconds,
        level: severity,
        message,
        service: resource,
        fields: { ...bound, ...(snapshot(extra) as Fields) },
        ...(scope ? { scope } : {}),
        ...(error ? { error } : {}),
        ...(trace ? { trace } : {}),
      };

      if (native) {
        const { level: _level, message: text, ...body } = record;
        native[severity](body, text);
      } else {
        output.write(consoleLine(record, color.value));
      }
    } catch {
      output.counts.failed += 1;
    }
  };

  return ok({
    log: new Logger(emit),
    stats: () => ({ ...output.counts }),
    close: (milliseconds) => output.close(milliseconds),
  });
}
