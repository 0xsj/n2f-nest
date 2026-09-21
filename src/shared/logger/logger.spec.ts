import { expect, it } from 'vitest';
import { failure, type Result } from '../errors/index.js';
import { parse } from '../id/index.js';
import { actor, attribution, Factory, operation } from '../provenance/index.js';
import { SecretString } from '../secret/index.js';
import { traceRef } from '../telemetry/index.js';
import {
  colorEnabled,
  create,
  parseLevel,
  type Config,
} from './index.js';

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error('unexpected failure');
  return result.value;
}

function fixture(extra: Partial<Config> = {}) {
  const lines: string[] = [];
  let calls = 0;
  const config: Config = {
    format: 'json',
    level: 'info',
    color: 'never',
    resource: { name: 'test' },
    clock: {
      now: () => {
        calls += 1;
        return new Date(1234);
      },
    },
    sink: {
      write: (line: string) => {
        lines.push(line);
      },
    },
    ...extra,
  };
  const runtime = value(create(config));
  return { runtime, lines, calls: () => calls, config };
}

it('filters levels and preserves no-op behavior', async () => {
  for (const level of ['debug', 'info', 'warn', 'error']) {
    expect(parseLevel(level).ok).toBe(true);
  }
  expect(parseLevel('INFO').ok).toBe(false);

  for (const format of ['console', 'json', 'none']) {
    const fixtureValue = fixture({ format });
    fixtureValue.runtime.log.debug('hidden');
    fixtureValue.runtime.log.info('visible');
    expect((await fixtureValue.runtime.close(1000)).ok).toBe(true);
    expect(fixtureValue.calls()).toBe(format === 'none' ? 0 : 1);
    expect(fixtureValue.lines.join('')).not.toContain('hidden');
    expect(fixtureValue.lines.length).toBe(format === 'none' ? 0 : 1);
  }
});

it('snapshots immutable fields and redacts secrets in JSON output', async () => {
  const fixtureValue = fixture();
  const nested = {
    token: new SecretString('credential-SENTINEL'),
    public: 'visible',
  };
  const parent = fixtureValue.runtime.log.with({ nested, keep: 1 });
  const child = parent.with({ keep: 2, extra: true });
  nested.public = 'changed';

  child.info('child');
  parent.info('parent');
  await fixtureValue.runtime.close(1000);

  const records = fixtureValue.lines.map((line) => JSON.parse(line));
  expect(records[0]).toMatchObject({
    timestamp_ms: 1234,
    level: 'info',
    fields: {
      keep: 2,
      extra: true,
      nested: { token: '[REDACTED]', public: 'visible' },
    },
  });
  expect(records[1].fields).toMatchObject({ keep: 1 });
  expect(records[1].fields.extra).toBeUndefined();
  expect(fixtureValue.lines.join('')).not.toContain('credential-SENTINEL');
});

it('projects trusted scopes and classified or unknown failures safely', async () => {
  const fixtureValue = fixture();
  const ids = {
    newId: () => parse('01900000-0000-7000-8000-000000000001'),
  };
  const factory = new Factory(fixtureValue.config.clock, ids);
  const scope = value(
    factory.open({
      origin: 'startup',
      attribution: value(attribution()),
      operation: value(operation('demo.run')),
      executor: value(actor('service', 'api')),
    }),
  );
  const log = value(fixtureValue.runtime.log.withScope(scope));

  log
    .withError(
      failure('unavailable', 'dependency unavailable', {
        type: 'demo.offline',
        cause: new Error('credential-SENTINEL'),
      }),
    )
    .warn('refused', { scope: { scope_id: 'forged' } });
  log
    .withError(failure('internal', 'credential-SENTINEL', { type: 'demo.internal' }))
    .error('internal');
  log.withError(new Error('credential-SENTINEL')).error('unknown');
  await fixtureValue.runtime.close(1000);

  const records = fixtureValue.lines.map((line) => JSON.parse(line));
  expect(records[0].scope.scope_id).toBe(scope.snapshot().scopeId);
  expect(records[0].error).toMatchObject({ kind: 'unavailable', has_cause: true });
  expect(records[1].error.type).toBe('demo.internal');
  expect(records[2].error.classified).toBe(false);
  expect(fixtureValue.lines.join('')).not.toContain('credential-SENTINEL');
});

it('handles color, console controls, and telemetry binding explicitly', async () => {
  for (const [mode, terminal, noColor, expected] of [
    ['auto', true, false, true],
    ['auto', true, true, false],
    ['auto', false, false, false],
    ['always', false, true, true],
    ['never', true, false, false],
  ] as const) {
    expect(colorEnabled(mode, terminal, noColor).value).toBe(expected);
  }
  expect(colorEnabled('bad', false, false).ok).toBe(false);

  const trace = value(
    traceRef('12345678901234567890123456789012', '1234567890123456', false),
  );
  const fixtureValue = fixture({ format: 'console', color: 'always' });
  value(fixtureValue.runtime.log.withTrace(trace))
    .with({ trace: 'forged' })
    .info('message\nforged\x1b[31m', { field: 'value\nnew' });
  await fixtureValue.runtime.close(1000);

  const output = fixtureValue.lines.join('');
  expect(output.split('\n')).toHaveLength(2);
  expect(output).not.toContain('forged\x1b');
  expect(output).toContain('\x1b[');
});

it('does not throw from sink failures and enforces queue bounds', async () => {
  const failed = fixture({
    sink: {
      write: () => {
        throw new Error('private sink detail');
      },
    },
  });
  expect(() => failed.runtime.log.info('event')).not.toThrow();
  const failedClose = await failed.runtime.close(1000);
  expect(failedClose.ok).toBe(false);
  if (!failedClose.ok) expect(failedClose.error.kind).toBe('unavailable');
  expect(failed.runtime.stats().failed).toBe(1);

  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bounded = fixture({ capacity: 1, sink: { write: () => pending } });
  bounded.runtime.log.info('first');
  bounded.runtime.log.info('queued');
  bounded.runtime.log.info('dropped');
  const timedOut = await bounded.runtime.close(5);
  expect(timedOut.ok).toBe(false);
  if (!timedOut.ok) expect(timedOut.error.kind).toBe('timeout');
  expect(bounded.runtime.stats().dropped).toBe(1);
  release();
  expect((await bounded.runtime.close(1000)).ok).toBe(true);
});

it('refuses invalid time, size, cyclic fields, and post-close emission', async () => {
  const fixtureValue = fixture();
  expect(create({ ...fixtureValue.config, format: 'bad' }).ok).toBe(false);
  await fixtureValue.runtime.close(1000);

  const invalidTime = fixture({ clock: { now: () => new Date(-1) } });
  invalidTime.runtime.log.info('invalid');
  expect(invalidTime.runtime.stats().failed).toBe(1);
  expect((await invalidTime.runtime.close(1000)).ok).toBe(false);

  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const cyclic = fixture();
  cyclic.runtime.log.info('cycle', cycle);
  expect(cyclic.runtime.stats().failed).toBe(1);
  expect(cyclic.lines).toEqual([]);
  expect((await cyclic.runtime.close(1000)).ok).toBe(false);

  const large = fixture({ maxRecordBytes: 64 });
  large.runtime.log.info('x'.repeat(100));
  await large.runtime.close(1000);
  large.runtime.log.info('closed');
  expect(large.runtime.stats().dropped).toBe(2);
  expect(large.lines).toEqual([]);
});

it('refuses accessor-backed array values without invoking accessors', async () => {
  let calls = 0;
  const array: unknown[] = [];
  Object.defineProperty(array, 0, {
    get() {
      calls += 1;
      return 'private';
    },
    enumerable: true,
  });
  const fixtureValue = fixture();
  fixtureValue.runtime.log.info('bad', { array });
  await fixtureValue.runtime.close(1000);
  expect(calls).toBe(0);
  expect(fixtureValue.runtime.stats().failed).toBe(1);
});
