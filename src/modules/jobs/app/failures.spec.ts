import { describe, expect, it } from 'vitest';
import { failure } from '../../../shared/errors/index.js';
import { dependencyFailure, idGenerationFailure } from './failures.js';

describe('Jobs application failures', () => {
  it('normalizes an open dependency failure by kind', () => {
    const result = dependencyFailure(
      failure('conflict', 'duplicate job', { type: 'jobs.unique_subject' }),
      'job.commit',
    );

    expect(result.type).toBe('job.dependency_conflict');
    expect(result.kind).toBe('conflict');
  });

  it('keeps ID generation failure in the module contract', () => {
    const result = idGenerationFailure(failure('unavailable', 'generator failed'));

    expect(result.type).toBe('job.id_generation');
    expect(result.kind).toBe('unavailable');
  });
});
