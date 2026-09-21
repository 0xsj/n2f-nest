import { describe, expect, it } from 'vitest';
import { parse } from '../../../shared/id/index.js';
import { Organization } from './organization.js';

const organizationId = parse('01900000-0000-7000-8000-000000000001');
if (!organizationId.ok) throw new Error('organization ID fixture is invalid');

const createdAt = new Date('2026-09-20T00:00:00.000Z');

describe('Organization', () => {
  it('normalizes names and slugs while starting active', () => {
    const result = Organization.create({
      id: organizationId.value,
      name: '  Signal Arts  ',
      slug: ' Signal-Arts ',
      createdAt,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('Signal Arts');
      expect(result.value.slug).toBe('signal-arts');
      expect(result.value.status).toBe('active');
      expect(result.value.createdAt).toEqual(createdAt);
    }
  });

  it('rejects invalid slugs at the domain boundary', () => {
    const result = Organization.create({
      id: organizationId.value,
      name: 'Signal Arts',
      slug: 'not a slug',
      createdAt,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('organization.invalid_slug');
  });

  it('transitions immutably and prevents archived renames', () => {
    const organization = Organization.create({
      id: organizationId.value,
      name: 'Signal Arts',
      slug: 'signal-arts',
      createdAt,
    });
    if (!organization.ok) throw new Error(organization.error.message);

    const archived = organization.value.archive(new Date('2026-09-20T01:00:00.000Z'));
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;

    expect(organization.value.status).toBe('active');
    expect(archived.value.status).toBe('archived');

    const renamed = archived.value.rename('Renamed', new Date('2026-09-20T02:00:00.000Z'));
    expect(renamed.ok).toBe(false);
    if (!renamed.ok) expect(renamed.error.type).toBe('organization.archived');
  });
});
