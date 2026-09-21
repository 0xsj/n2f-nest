import { expect, it } from 'vitest';
import { os } from './index.js';

it('captures the process environment once', () => {
  const key = 'SIGNALS_ENV_SNAPSHOT_FIXTURE';
  const previous = process.env[key];
  try {
    process.env[key] = 'before';
    const captured = os();
    expect(captured.ok).toBe(true);
    process.env[key] = 'after';
    if (captured.ok) expect(captured.value(key)).toBe('before');
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});
