import { expect, it } from 'vitest';
import * as provenance from './index.js';
import { parse, type ID } from '../id/index.js';
import {
  failure,
  type Failure,
  type Result,
} from '../errors/index.js';

function value<T>(result: Result<T, Failure>): T {
  if (!result.ok) throw new Error(result.error.type);
  return result.value;
}

const id = (number: number): ID =>
  value(
    parse(
      `01900000-0000-7000-8000-${number.toString(16).padStart(12, '0')}`,
    ),
  );

const makeActor = () => value(provenance.actor('service', 'api'));
const makeOperation = () => value(provenance.operation('demo.export'));

const root = (): provenance.RootSpec => ({
  origin: 'startup',
  operation: makeOperation(),
  executor: makeActor(),
  attribution: value(provenance.attribution()),
});

const step = (): provenance.StepSpec => ({
  operation: makeOperation(),
  executor: makeActor(),
});

function setup() {
  const state = { time: new Date(1000), clock: 0, ids: 0 };
  const factory = new provenance.Factory(
    {
      now() {
        state.clock += 1;
        return state.time;
      },
    },
    {
      newId() {
        return { ok: true as const, value: id(++state.ids) };
      },
    },
  );
  return { factory, state };
}

function typeOf(result: Result<unknown, Failure>): string {
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.error.type ?? '';
}

it('keeps unknown, anonymous and named attribution distinct', () => {
  for (const identity of ['', 'a b', 'é', 'a'.repeat(129)]) {
    expect(typeOf(provenance.actor('user', identity))).toBe(
      'provenance.invalid_actor',
    );
  }

  const alice = value(provenance.actor('user', 'alice'));
  const bob = value(provenance.actor('user', 'bob'));
  const spec = { initiator: alice, onBehalfOf: bob, tenant: 'acme' };
  const attributed = value(provenance.attribution(spec));

  spec.tenant = 'other';
  expect(attributed.tenant).toBe('acme');
  for (const invalid of [
    { onBehalfOf: bob },
    { initiator: provenance.anonymous(), onBehalfOf: bob },
    { initiator: alice, onBehalfOf: alice },
  ]) {
    expect(typeOf(provenance.attribution(invalid))).toBe(
      'provenance.invalid_attribution',
    );
  }

  expect(value(provenance.attribution()).initiator).toBeUndefined();
  expect(provenance.anonymous().kind).toBe('anonymous');
});

it('supports root, child, prepared work, execution and retry transitions', () => {
  const { factory, state } = setup();
  const spec = root();
  spec.attribution = value(provenance.attribution({ tenant: 'acme' }));
  const opened = value(factory.open(spec));
  const openedSnapshot = opened.snapshot();

  expect([
    openedSnapshot.scopeId,
    openedSnapshot.work.workId,
    openedSnapshot.work.correlationId,
  ]).toEqual([id(1), id(1), id(1)]);
  expect([
    openedSnapshot.attempt,
    openedSnapshot.work.depth,
    state.clock,
    state.ids,
  ]).toEqual([1, 0, 1, 1]);

  const child = value(factory.child(opened, step())).snapshot();
  expect(child.work.causation?.id).toBe(openedSnapshot.scopeId);
  expect(child.work.depth).toBe(1);
  expect(child.work.attribution.tenant).toBe('acme');

  const before = state.ids;
  const cause = value(provenance.reference('event', id(90)));
  const prepared = value(
    provenance.prepare(opened, {
      workId: id(50),
      operation: makeOperation(),
      cause,
    }),
  );
  expect([state.clock, state.ids]).toEqual([before, before]);

  const executed = value(
    factory.execute(prepared, { executor: makeActor(), attempt: 1 }),
  );
  state.time = new Date(2000);
  const retried = value(factory.retry(executed, value(provenance.actor('service', 'worker')))).snapshot();
  expect([
    retried.work.workId,
    retried.attempt,
    retried.previousAttempt,
    retried.executor.identity,
  ]).toEqual([id(50), 2, executed.snapshot().scopeId, 'worker']);
  expect(retried.work.causation).toEqual(cause);
  expect(retried.startedAt.getTime()).toBe(2000);

  const concurrentRetry = value(factory.retry(executed, makeActor())).snapshot();
  expect(concurrentRetry.attempt).toBe(2);
  expect(concurrentRetry.scopeId).not.toBe(retried.scopeId);
  expect(
    value(factory.execute(prepared, { executor: makeActor(), attempt: 3 })).snapshot()
      .previousAttempt,
  ).toBeUndefined();

  const explicitRoot = root();
  explicitRoot.workId = id(80);
  const explicit = value(factory.open(explicitRoot)).snapshot();
  expect(explicit.work.workId).toBe(id(80));
  expect(explicit.work.correlationId).toBe(explicit.scopeId);
});

it('accepts message as a local origin', () => {
  const { factory } = setup();
  const spec = root();
  spec.origin = 'message';
  expect(value(factory.open(spec)).snapshot().work.origin).toBe('message');
});

it('bounds attempts, depth and wall corrections', () => {
  const { factory, state } = setup();
  const opened = value(factory.open(root()));
  const snapshot = opened.snapshot();

  snapshot.attempt = 4294967295;
  expect(typeOf(factory.retry(value(provenance.restoreScope(snapshot)), makeActor()))).toBe(
    'provenance.attempt_exhausted',
  );
  expect([state.clock, state.ids]).toEqual([1, 1]);

  const deep = opened.snapshot();
  deep.work.depth = 4294967295;
  deep.work.causation = value(provenance.reference('event', id(90)));
  expect(typeOf(factory.child(value(provenance.restoreScope(deep)), step()))).toBe(
    'provenance.depth_exhausted',
  );

  state.time = new Date(1);
  expect(value(factory.child(opened, step())).snapshot().startedAt.getTime()).toBe(1);
});

it('validates before effects and forwards generator failures', () => {
  const { factory, state } = setup();
  const invalidRoot = root();
  invalidRoot.executor = provenance.anonymous();
  expect(typeOf(factory.open(invalidRoot))).toBe('provenance.invalid_actor');
  expect([state.clock, state.ids]).toEqual([0, 0]);

  state.time = new Date(-1);
  expect(typeOf(factory.open(root()))).toBe('provenance.invalid_time');
  expect(state.ids).toBe(0);

  const generatorFailure = failure('unavailable', 'entropy', {
    type: 'id.entropy',
    cause: new Error('source'),
  });
  const broken = new provenance.Factory(
    { now: () => new Date(0) },
    { newId: () => ({ ok: false, error: generatorFailure }) },
  );
  const result = broken.open(root());
  expect(!result.ok && result.error).toBe(generatorFailure);

  const collision = new provenance.Factory(
    { now: () => new Date(0) },
    { newId: () => ({ ok: true, value: id(1) }) },
  );
  const opened = value(collision.open(root()));
  expect(typeOf(collision.child(opened, step()))).toBe(
    'provenance.invalid_generated_id',
  );
  expect(typeOf(factory.child({} as provenance.Scope, step()))).toBe(
    'provenance.invalid_scope',
  );
  expect(typeOf(factory.enter(root(), {} as provenance.IncomingResult))).toBe(
    'provenance.invalid_incoming_result',
  );

  const forged = root();
  forged.executor = { kind: 'service', identity: 'forged' };
  expect(typeOf(factory.open(forged))).toBe('provenance.invalid_actor');
});

it('keeps links bounded, copied and parent-neutral', () => {
  const target = value(provenance.reference('event', id(90)));
  const link: provenance.Link = { relation: 'input', target };
  const input = [link, link];
  const links = value(provenance.linkSet(input));

  input.pop();
  expect(links.values()).toEqual([link]);
  const view = links.values();
  view.pop();
  expect(links.values()).toEqual([link]);
  expect(
    typeOf(provenance.linkSet(Array(33).fill(link) as provenance.Link[])),
  ).toBe('provenance.too_many_links');
  expect(
    typeOf(
      provenance.linkSet([{ relation: 'previous_attempt', target }]),
    ),
  ).toBe('provenance.invalid_reference');
});

it('opens replay as a new lineage and retains replay context in children', () => {
  const { factory } = setup();
  const opened = value(factory.open(root()));
  const source = value(
    provenance.reference('work', opened.snapshot().work.workId),
  );
  const spec: provenance.ReplaySpec = {
    source,
    operation: makeOperation(),
    executor: makeActor(),
    attribution: value(provenance.attribution()),
  };

  const replay = value(factory.replay(spec));
  const snapshot = replay.snapshot();
  expect(snapshot.work.correlationId).toBe(snapshot.scopeId);
  expect(snapshot.work.workId).not.toBe(source.id);
  expect(snapshot.work.replay?.runId).toBe(snapshot.scopeId);
  expect(snapshot.work.origin).toBe('replay');
  expect(snapshot.work.causation).toBeUndefined();
  expect(value(factory.child(replay, step())).snapshot().work.replay).toEqual(
    snapshot.work.replay,
  );
  expect(typeOf(factory.replay({ ...spec, workId: source.id }))).toBe(
    'provenance.invalid_work',
  );
});

it('distinguishes fresh, continued and restarted incoming contexts', () => {
  const { factory } = setup();
  const good = id(80).toUpperCase();
  const cases: [provenance.IncomingHints, string, number, boolean][] = [
    [{}, 'fresh', 0, false],
    [{ correlation: good }, 'continued', 0, false],
    [
      { correlation: good, causation: { kind: 'scope', id: id(90) } },
      'continued',
      0,
      true,
    ],
    [
      {
        correlation: good,
        causation: { kind: 'scope', id: 'private-SENTINEL' },
      },
      'continued',
      1,
      false,
    ],
    [
      { correlation: 'bad', causation: { kind: 'scope', id: id(90) } },
      'restarted',
      2,
      false,
    ],
    [{ correlation: '' }, 'restarted', 1, false],
  ];

  for (const [hints, disposition, issueCount, hasCause] of cases) {
    const incoming = provenance.inspectIncoming(hints);
    expect(incoming.decision).toBe(disposition);
    expect(incoming.issues()).toHaveLength(issueCount);
    expect(JSON.stringify(incoming.issues())).not.toContain('private-SENTINEL');

    const scope = value(factory.enter(root(), incoming));
    const snapshot = scope.snapshot();
    if (disposition === 'continued') {
      expect(snapshot.work.correlationId).toBe(id(80));
      expect(snapshot.work.origin).toBeUndefined();
      expect(snapshot.work.depth).toBeUndefined();
      expect(snapshot.work.causation !== undefined).toBe(hasCause);
      expect(value(factory.child(scope, step())).snapshot().work.depth).toBeUndefined();
    } else {
      expect(snapshot.work.correlationId).toBe(snapshot.scopeId);
      expect(snapshot.work.causation).toBeUndefined();
    }
  }
});

it('owns snapshots and refuses inconsistent restoration', () => {
  const { factory, state } = setup();
  const opened = value(factory.open(root()));
  state.time.setTime(5000);
  expect(opened.snapshot().startedAt.getTime()).toBe(1000);

  const original = opened.snapshot();
  const changed = opened.snapshot();
  changed.work.depth = 9;
  changed.startedAt.setTime(999);
  expect(opened.snapshot()).toEqual(original);

  const invalidAttempt = opened.snapshot();
  invalidAttempt.attempt = 0;
  expect(typeOf(provenance.restoreScope(invalidAttempt))).toBe(
    'provenance.invalid_attempt',
  );

  const selfPrevious = opened.snapshot();
  selfPrevious.previousAttempt = selfPrevious.scopeId;
  expect(typeOf(provenance.restoreScope(selfPrevious))).toBe(
    'provenance.invalid_scope',
  );

  const invalidReplay = opened.snapshot();
  invalidReplay.work.replay = {
    runId: id(80),
    source: value(provenance.reference('event', id(90))),
  };
  expect(typeOf(provenance.restoreScope(invalidReplay))).toBe(
    'provenance.invalid_origin',
  );

  const invalidWork = opened.snapshot().work;
  invalidWork.causation = value(
    provenance.reference('work', invalidWork.workId),
  );
  expect(provenance.restoreWork(invalidWork).ok).toBe(false);
});
