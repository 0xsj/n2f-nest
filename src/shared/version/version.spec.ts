import { describe, expect, it } from 'vitest';
import { FIRST, UNSAVED, isStoredVersion } from './index.js';

describe('version', () => {
  it('accepts only positive safe integers as stored versions', () => {
    expect(isStoredVersion(FIRST)).toBe(true);
    expect(isStoredVersion(42)).toBe(true);
    for (const value of [UNSAVED, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, '1', null]) {
      expect(isStoredVersion(value)).toBe(false);
    }
  });
});
