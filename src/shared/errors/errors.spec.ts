import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AppError,
  KINDS,
  causeOf,
  detailsOf,
  err,
  failure,
  fromCaught,
  kindOf,
  mapError,
  ok,
  parseKind,
  publicInfo,
  withCause,
  withDetails,
  withFields,
} from './index.js';
import type { Failure } from './index.js';

const internal = { kind: 'internal', message: 'internal error' };

describe('errors', () => {
  it('has the ten stable kind names and rejects unknown names', () => {
    const names = [
      'internal',
      'invalid',
      'not_found',
      'conflict',
      'unauthenticated',
      'forbidden',
      'rate_limited',
      'unavailable',
      'timeout',
      'canceled',
    ];

    expect(KINDS).toHaveLength(names.length);
    expect(new Set(KINDS)).toEqual(new Set(names));
    for (const name of names) expect(parseKind(name)).toBe(name);
    for (const unknown of ['', 'INTERNAL', 'not-found', 'other', null, 1]) {
      expect(parseKind(unknown)).toBeUndefined();
    }
    expect(Object.isFrozen(KINDS)).toBe(true);
  });

  it('constructs deliberate public data and preserves literal types', () => {
    const error = failure('invalid', 'email is required', {
      type: 'account.email_required',
      fields: { email: 'required' },
    });

    expect(kindOf(error)).toBe('invalid');
    expect(publicInfo(error)).toEqual({
      kind: 'invalid',
      message: 'email is required',
      type: 'account.email_required',
      fields: { email: 'required' },
    });
    expectTypeOf(error.kind).toEqualTypeOf<'invalid'>();
    expectTypeOf(error.type).toEqualTypeOf<
      'account.email_required' | undefined
    >();
    expect(publicInfo(failure('conflict', '')).message).toBe('request failed');
  });

  it('preserves success and keeps unknown values distinct from internal', () => {
    const result = ok(42);
    const mapped = mapError(result, () => {
      throw new Error('success entered error branch');
    });
    expect(mapped).toEqual({ ok: true, value: 42 });

    for (const value of [
      null,
      undefined,
      new Error('PRIVATE'),
      { kind: 'internal', message: 'PRIVATE' },
    ]) {
      expect(kindOf(value)).toBeUndefined();
    }

    expect(kindOf(failure('internal', 'unexpected'))).toBe('internal');
    const condition = failure('conflict', 'email taken', {
      type: 'account.email_taken',
    });
    const failed = mapError(err(condition), (error) =>
      withDetails(error, { operation: 'register' }),
    );

    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(detailsOf(failed.error)).toEqual({ operation: 'register' });
      expectTypeOf(failed.error.kind).toEqualTypeOf<'conflict'>();
    }
  });

  it('projects only explicitly public information', () => {
    const secret = failure('internal', 'PRIVATE message', {
      type: 'PRIVATE.type',
      fields: { PRIVATE: 'field' },
      details: { sql: 'PRIVATE SQL' },
      cause: new Error('PRIVATE cause'),
    });

    for (const value of [
      secret,
      new Error('PRIVATE'),
      { kind: 'invalid', message: 'PRIVATE' },
    ]) {
      expect(publicInfo(value)).toEqual(internal);
    }

    expect(detailsOf(secret)).toEqual({ sql: 'PRIVATE SQL' });
    for (const kind of KINDS.filter((kind) => kind !== 'internal')) {
      expect(
        publicInfo(
          failure(kind, 'safe message', {
            type: 'module.condition',
            fields: { input: 'problem' },
          }),
        ),
      ).toEqual({
        kind,
        message: 'safe message',
        type: 'module.condition',
        fields: { input: 'problem' },
      });
    }
    expect(JSON.stringify(publicInfo(secret))).not.toContain('PRIVATE');
  });

  it('isolates input, derived and projected metadata at runtime', () => {
    const fields = { email: 'required' };
    const details = { operation: 'insert' };
    const base = failure('invalid', 'invalid input', { fields, details });

    fields.email = 'MUTATED';
    details.operation = 'MUTATED';
    expect(publicInfo(base).fields).toEqual({ email: 'required' });
    expect(detailsOf(base)).toEqual({ operation: 'insert' });

    const derived = withDetails(withFields(base, { email: 'malformed' }), {
      operation: 'register',
    });
    const view = publicInfo(derived);
    const diagnostic = detailsOf(derived);
    expect(view.fields).toEqual({ email: 'malformed' });
    if (!view.fields) throw new Error('missing fields');

    view.fields.email = 'MUTATED';
    diagnostic.operation = 'MUTATED';
    expect(publicInfo(derived).fields).toEqual({ email: 'malformed' });
    expect(detailsOf(derived)).toEqual({ operation: 'register' });
    expect(publicInfo(base).fields).toEqual({ email: 'required' });
    expect(detailsOf(base)).toEqual({ operation: 'insert' });
    expect(Object.isFrozen(base)).toBe(true);
    expect(Object.isFrozen(base.fields)).toBe(true);
  });

  it('preserves the local condition and cause through enrichment', () => {
    const cause = new Error('PRIVATE database detail');
    const condition = failure('conflict', 'email taken', {
      type: 'account.email_taken',
    });
    const occurrence = withCause(condition, cause);
    const annotated = withDetails(occurrence, { operation: 'register' });

    expect(publicInfo(annotated)).toEqual(publicInfo(condition));
    expect(kindOf(annotated)).toBe('conflict');
    expectTypeOf(annotated.type).toEqualTypeOf<
      'account.email_taken' | undefined
    >();
    expect(causeOf(annotated)).toBe(cause);
    expect(causeOf(condition)).toBeUndefined();
    expect(detailsOf(condition)).toEqual({});
  });

  it('lets an explicit outer classification own its projection', () => {
    const inner = failure('conflict', 'inner', {
      type: 'inner.type',
      fields: { inner: 'field' },
      details: { inner: 'detail' },
    });
    const outer = withCause(failure('unavailable', 'try later'), inner);

    expect(publicInfo(outer)).toEqual({
      kind: 'unavailable',
      message: 'try later',
    });
    expect(detailsOf(outer)).toEqual({});
    expect(causeOf(outer)).toBe(inner);

    const replacement = new Error('replacement');
    expect(causeOf(withCause(outer, replacement))).toBe(replacement);
    expect(causeOf(outer)).toBe(inner);
  });

  it('preserves explicit cancellation and deadline classification', () => {
    for (const kind of ['timeout', 'canceled'] as const) {
      expect(
        kindOf(
          withDetails(failure(kind, 'operation stopped'), {
            operation: 'register',
          }),
        ),
      ).toBe(kind);
    }

    const foreign = new Error('context canceled');
    foreign.name = 'TimeoutError';
    expect(kindOf(foreign)).toBeUndefined();
    expect(kindOf(fromCaught(foreign))).toBe('internal');
  });

  it('does not derive an aggregate classification from one branch', () => {
    const known = failure('unavailable', 'try later', {
      type: 'dependency.offline',
    });
    const unknown = new Error('PRIVATE unknown');

    for (const items of [
      [known, unknown],
      [unknown, known],
    ]) {
      const aggregate = new AggregateError(items, 'PRIVATE aggregate');
      expect(kindOf(aggregate)).toBeUndefined();
      expect(publicInfo(aggregate)).toEqual(internal);

      const summary = withCause(
        failure('unavailable', 'batch interrupted'),
        aggregate,
      );
      expect(kindOf(summary)).toBe('unavailable');
      expect(causeOf(summary)).toBe(aggregate);
      expect(aggregate.errors).toEqual(items);
    }
  });

  it('normalizes nullish, primitive and hostile caught values', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('getter');
        },
        getPrototypeOf() {
          throw new Error('prototype');
        },
      },
    );

    for (const value of [null, undefined, 'PRIVATE', 42, hostile]) {
      const normalized = fromCaught(value);
      expect(kindOf(normalized)).toBe('internal');
      expect(publicInfo(normalized)).toEqual(internal);
      expect(causeOf(normalized) === value).toBe(true);
    }
  });

  it('recognizes only genuine carriers and retains their trusted failure', () => {
    const cause = new Error('PRIVATE cause');
    const condition = failure('conflict', 'email taken', {
      type: 'account.email_taken',
      cause,
    });
    const carrier = new AppError(condition);

    expect(fromCaught(condition)).toBe(condition);
    expect(fromCaught(carrier)).toBe(condition);
    expect(kindOf(carrier)).toBe('conflict');
    expect(causeOf(carrier)).toBe(cause);

    Object.defineProperty(carrier, 'failure', {
      get() {
        throw new Error('foreign getter');
      },
    });
    expect(fromCaught(carrier)).toBe(condition);
    expect(kindOf(Object.create(AppError.prototype))).toBeUndefined();
    expect(
      () => new AppError({ kind: 'invalid', message: 'untrusted' } as Failure),
    ).toThrow(TypeError);
  });

  it('merges metadata and preserves meaning while replacing the source', () => {
    const first = new Error('PRIVATE first');
    const second = new Error('PRIVATE second');
    const base = failure('invalid', 'invalid input', {
      type: 'account.invalid',
      fields: { email: 'required', name: 'required' },
      details: { operation: 'insert', attempt: '1' },
      cause: first,
    });
    const derived = withCause(
      withDetails(withFields(base, { email: 'malformed', age: 'positive' }), {
        operation: 'register',
        worker: 'signup',
      }),
      second,
    );

    expect(publicInfo(derived)).toEqual({
      kind: 'invalid',
      message: 'invalid input',
      type: 'account.invalid',
      fields: { email: 'malformed', name: 'required', age: 'positive' },
    });
    expect(detailsOf(derived)).toEqual({
      operation: 'register',
      attempt: '1',
      worker: 'signup',
    });
    expect(causeOf(derived)).toBe(second);
    expect(causeOf(base)).toBe(first);
    expect(publicInfo(base).fields).toEqual({
      email: 'required',
      name: 'required',
    });
    expect(detailsOf(base)).toEqual({ operation: 'insert', attempt: '1' });
    expectTypeOf(derived.kind).toEqualTypeOf<'invalid'>();
    expectTypeOf(derived.type).toEqualTypeOf<
      'account.invalid' | undefined
    >();

    const emptyType = withDetails(failure('conflict', '', { type: '' }), {
      operation: 'register',
    });
    expect(publicInfo(emptyType)).toEqual({
      kind: 'conflict',
      message: 'request failed',
    });
  });
});
