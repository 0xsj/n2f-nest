import { expect, it } from 'vitest';
import { Reader, map } from './index.js';

it('rejects trailing line terminators without echoing invalid keys', () => {
  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    const reader = new Reader(map({ N: `2${suffix}` }));
    reader.int('N', 1, 0, 10);
    expect(reader.check().ok).toBe(false);

    const invalidKey = new Reader(map({}));
    invalidKey.string(`PRIVATE${suffix}`, 'x');
    const result = invalidKey.check();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  }
});
