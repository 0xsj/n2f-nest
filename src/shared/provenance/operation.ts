import { err, ok, type Failure, type Result } from '../errors/index.js';
import { invalid } from './actor.js';

declare const operationBrand: unique symbol;

export type Operation = string & {
  readonly [operationBrand]: true;
};

export const validOperation = (value: unknown): value is Operation =>
  typeof value === 'string' && /^[a-z][a-z0-9_.:-]{0,127}$/.test(value);

export function operation(value: string): Result<Operation, Failure> {
  return validOperation(value)
    ? ok(value)
    : err(invalid('invalid_operation'));
}
