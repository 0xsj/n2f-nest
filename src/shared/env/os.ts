import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';
import { map, type Lookup } from './lookup.js';

export function os(): Result<Lookup, Failure> {
  const values: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  try {
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      encodeURIComponent(key);
      encodeURIComponent(value);
      values[key] = value;
    }
    return ok(map(values));
  } catch {
    return err(
      failure('invalid', 'invalid environment source', {
        type: 'env.source',
      }),
    );
  }
}
