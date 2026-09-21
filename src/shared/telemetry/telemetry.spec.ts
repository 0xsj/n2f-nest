import { describe, expect, it } from 'vitest';
import { kindOf, publicInfo } from '../errors/index.js';
import { parseOutcome, snapshot, traceRef } from './index.js';

describe('telemetry leaves', () => {
  it('reject malformed and zero trace identities', () => {
    for (const [trace, span] of [
      ['', '0000000000000000'],
      ['00000000000000000000000000000000', '0123456789abcdef'],
      ['ABCDEF0123456789ABCDEF0123456789', '0123456789abcdef'],
      ['0123456789abcdef0123456789abcdef', '0123456789abcdeg'],
    ]) {
      const result = traceRef(trace, span, true);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(publicInfo(result.error).type).toBe(
          'telemetry.invalid_context',
        );
      }
    }
  });

  it('owns snapshots and preserves sampling', () => {
    const result = traceRef(
      '0123456789abcdef0123456789abcdef',
      '0123456789abcdef',
      false,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(snapshot(result.value)).toEqual({
        traceId: '0123456789abcdef0123456789abcdef',
        spanId: '0123456789abcdef',
        sampled: false,
      });
    }
  });

  it('keeps outcome parsing exact and closed', () => {
    for (const value of [
      'success',
      'refused',
      'failed',
      'canceled',
      'timed_out',
    ]) {
      expect(parseOutcome(value)).toEqual({ ok: true, value });
    }
    for (const value of ['', 'SUCCESS', 'unknown', 'timed-out']) {
      const result = parseOutcome(value);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(publicInfo(result.error).type).toBe(
          'telemetry.invalid_outcome',
        );
      }
    }
  });

  it('does not confuse a failed Result with an absent success value', () => {
    const failed = parseOutcome(undefined);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(kindOf(failed.error)).toBe('invalid');
  });
});
