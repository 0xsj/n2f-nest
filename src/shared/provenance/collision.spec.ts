import { expect, it } from 'vitest';
import {
  Factory,
  actor,
  attribution,
  operation,
  reference,
} from './index.js';
import { parse, type Result } from '../id/index.js';

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error('fixture');
  return result.value;
}

it('does not let an explicit cause hide a reused execution identity', () => {
  const ids = {
    newId: () => parse('01900000-0000-7000-8000-000000000001'),
  };
  const factory = new Factory({ now: () => new Date(0) }, ids);
  const executor = value(actor('service', 'api'));
  const operationValue = value(operation('demo.run'));
  const parent = value(
    factory.open({
      origin: 'startup',
      operation: operationValue,
      executor,
      attribution: value(attribution()),
    }),
  );

  const result = factory.child(parent, {
    operation: operationValue,
    executor,
    workId: value(parse('01900000-0000-7000-8000-000000000002')),
    cause: value(
      reference('event', value(parse('01900000-0000-7000-8000-000000000003'))),
    ),
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.type).toBe('provenance.invalid_generated_id');
  }
});
