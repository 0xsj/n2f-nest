import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';

export type Level = 'debug' | 'info' | 'warn' | 'error';

export const rank: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Resource {
  name: string;
  namespace?: string;
  version?: string;
  instance_id?: string;
  environment?: string;
}

export interface Sink {
  write(line: string): void | Promise<void>;
  flush?(): void | Promise<void>;
}

export interface Config {
  format?: string;
  level?: string;
  color?: string;
  terminal?: boolean;
  noColor?: boolean;
  clock: { now(): Date };
  sink: Sink;
  resource: Resource;
  capacity?: number;
  maxRecordBytes?: number;
}

export const invalid = (): Failure =>
  failure('invalid', 'invalid logger configuration', {
    type: 'logger.invalid_configuration',
  });

export function parseLevel(value: string): Result<Level, Failure> {
  return Object.hasOwn(rank, value)
    ? ok(value as Level)
    : err(invalid());
}

export function colorEnabled(
  mode: string,
  terminal: boolean,
  noColor: boolean,
): Result<boolean, Failure> {
  switch (mode) {
    case 'auto':
      return ok(terminal && !noColor);
    case 'always':
      return ok(true);
    case 'never':
      return ok(false);
    default:
      return err(invalid());
  }
}
