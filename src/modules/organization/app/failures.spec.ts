import { describe, expect, it } from 'vitest';
import { failure } from '../../../shared/errors/index.js';
import { dependencyFailure, idGenerationFailure } from './failures.js';

describe('Organization application failures', () => {
  it('normalizes an open dependency failure by kind', () => {
    const result = dependencyFailure(
      failure('forbidden', 'identity rejected access', { type: 'identity.forbidden' }),
      'identity.current.find',
    );

    expect(result.type).toBe('organization.dependency_forbidden');
    expect(result.kind).toBe('forbidden');
  });

  it('keeps the operation-specific ID generation code', () => {
    const result = idGenerationFailure(
      failure('unavailable', 'generator failed'),
      'organization.membership.id_generation',
    );

    expect(result.type).toBe('organization.membership.id_generation');
    expect(result.kind).toBe('unavailable');
  });
});
