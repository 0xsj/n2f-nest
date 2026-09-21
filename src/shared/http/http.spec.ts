import { describe, expect, it } from 'vitest';
import { err, failure, ok } from '../errors/index.js';
import {
  classifyCompletion,
  decodeObject,
  normalizeMethod,
  problemOf,
  stringFields,
} from './index.js';

describe('HTTP shared boundaries', () => {
  it('projects safe problems and normalizes methods', () => {
    const problem = problemOf(
      err(
        failure('conflict', 'taken', {
          type: 'identity.account_taken',
          fields: { email: 'already registered' },
        }),
      ),
    );
    expect(problem?.status).toBe(409);
    expect(problem?.code).toBe('identity.account_taken');
    expect(problemOf(ok(undefined))).toBeUndefined();
    expect(normalizeMethod('get')).toBe('_OTHER');
  });

  it('classifies response and transport completion facts', () => {
    for (const [status, outcome, spanError] of [
      [200, 'success', false],
      [409, 'refused', false],
      [500, 'failed', true],
    ] as const) {
      const result = classifyCompletion({
        status,
        termination: 'response_completed',
      });
      expect(result).toEqual({
        ok: true,
        value: {
          outcome,
          spanError,
          ...(status === 500 ? { errorType: '500' } : {}),
        },
      });
    }
    expect(classifyCompletion({ termination: 'peer_closed' })).toEqual({
      ok: true,
      value: { outcome: 'canceled', spanError: true, errorType: 'canceled' },
    });
    expect(classifyCompletion({ termination: 'response_completed' }).ok).toBe(
      false,
    );
  });

  it('decodes bounded object JSON without duplicate keys', () => {
    expect(decodeObject(new TextEncoder().encode('{"name":"Ada"}'))).toEqual({
      ok: true,
      value: { name: 'Ada' },
    });
    expect(stringFields(new TextEncoder().encode('{"email":"a@b.test"}'), [
      'email',
    ])).toEqual({ ok: true, value: { email: 'a@b.test' } });
    expect(
      decodeObject(new TextEncoder().encode('{"name":1,"name":2}')).ok,
    ).toBe(false);
    expect(
      decodeObject(new TextEncoder().encode('{"nested":{"x":{"y":1}}}')).ok,
    ).toBe(true);
    expect(
      stringFields(new TextEncoder().encode('{"email":""}'), ['email']).ok,
    ).toBe(false);
  });
});
