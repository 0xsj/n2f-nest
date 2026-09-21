import { expect, it } from 'vitest';
import { Sequence, parse } from '../id/index.js';
import { FakeClock } from '../clock/index.js';
import {
  Factory,
  actor,
  attribution,
  operation,
} from '../provenance/index.js';
import { Envelope } from './index.js';

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error('fixture');
  return result.value;
}

function work() {
  const first = value(parse('00000000-0000-4000-8000-000000000001'));
  const second = value(parse('00000000-0000-4000-8000-000000000002'));
  const factory = new Factory(
    new FakeClock(new Date(1000)),
    new Sequence([first, second]),
  );
  return value(
    factory.open({
      origin: 'message',
      operation: value(operation('identity.principal_created')),
      attribution: value(attribution({ tenant: 'org-1' })),
      executor: value(actor('service', 'identity')),
    }),
  ).workContext();
}

it('owns bytes and preserves full producer provenance', () => {
  const event = value(
    Envelope.create(
      value(parse('00000000-0000-4000-8000-000000000003')),
      'identity.principal_created.v1',
      1000,
      work(),
      { safe: true, private: 'fixture-SENTINEL' },
    ),
  );
  const decoded = value(Envelope.decode(event.bytes()));
  expect(decoded.work.snapshot()).toEqual(event.work.snapshot());
  expect(decoded.type).toBe('identity.principal_created.v1');
  expect(decoded.occurredAtMs).toBe(1000);
  expect(decoded.payload()).toEqual({ safe: true, private: 'fixture-SENTINEL' });

  const bytes = event.bytes();
  bytes[0] = 33;
  expect(Envelope.decode(event.bytes()).ok).toBe(true);
  expect(JSON.stringify(event.bytes())).not.toContain('fixture-SENTINEL');

  for (const [key, changed] of Object.entries({
    v: 2,
    id: 'invalid',
    type: 'unversioned',
    occurred_at_ms: -1,
    payload: [],
  })) {
    const wire = JSON.parse(Buffer.from(event.bytes()).toString());
    wire[key] = changed;
    expect(Envelope.decode(Buffer.from(JSON.stringify(wire))).ok, key).toBe(
      false,
    );
  }
});
