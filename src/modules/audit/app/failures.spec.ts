import { describe, expect, it } from 'vitest';
import { failure } from '../../../shared/errors/index.js';
import { dependencyFailure, idGenerationFailure } from './failures.js';

describe('Audit application failures', () => {
  it('normalizes an open dependency failure by kind', () => {
    const result = dependencyFailure(
      failure('timeout', 'database timed out', { type: 'postgres.timeout' }),
      'audit.record',
    );

    expect(result.type).toBe('audit.dependency_timeout');
    expect(result.kind).toBe('timeout');
  });

  it('keeps ID generation failure in the module contract', () => {
    const result = idGenerationFailure(
      failure('unavailable', 'generator unavailable'),
    );

    expect(result.type).toBe('audit.id_generation');
    expect(result.kind).toBe('unavailable');
  });
});
