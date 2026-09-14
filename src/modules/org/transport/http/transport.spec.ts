import { describe, expect, it } from 'vitest';
import { decodeObject, stringFields } from '../../../../shared/http/json.js';

describe('organization HTTP body contract', () => {
  it('accepts exactly one name string and refuses duplicates, unknowns and nested values', () => {
    expect(stringFields(new TextEncoder().encode('{"name":"Team"}'), ['name'])).toEqual({ ok: true, value: { name: 'Team' } });
    for (const raw of ['{}', '{"name":""}', '{"name":"Team","name":"Again"}', '{"name":"Team","extra":"x"}', '{"name":{"nested":true}}', '{"name":"Team"} trailing'])
      expect(stringFields(new TextEncoder().encode(raw), ['name']).ok).toBe(false);
    expect(decodeObject(new TextEncoder().encode('{"name":"Team"}')).ok).toBe(true);
  });
});
