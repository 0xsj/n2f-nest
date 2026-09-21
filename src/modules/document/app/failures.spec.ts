import { describe, expect, it } from 'vitest';
import { failure } from '../../../shared/errors/index.js';
import { dependencyFailure, idGenerationFailure } from './failures.js';

describe('Document application failures', () => {
  it('normalizes an open dependency failure by kind', () => {
    const result = dependencyFailure(
      failure('unavailable', 'object store unavailable', { type: 'storage.down' }),
      'document.commit',
    );

    expect(result.type).toBe('document.dependency_unavailable');
    expect(result.kind).toBe('unavailable');
  });

  it('keeps ID generation failure in the module contract', () => {
    const result = idGenerationFailure(failure('internal', 'generator failed'));

    expect(result.type).toBe('document.id_generation');
    expect(result.kind).toBe('unavailable');
  });
});
