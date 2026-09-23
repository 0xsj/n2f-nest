import { describe, expect, it } from 'vitest';
import { parse } from '../../../shared/id/index.js';
import {
  ORGANIZATION_STATUSES,
  Organization,
  type OrganizationStatus,
  type RestoreOrganizationInput,
} from './organization.js';

const organizationId = parse('01900000-0000-7000-8000-000000000001');
if (!organizationId.ok) throw new Error('organization ID fixture is invalid');
const id = organizationId.value;

const createdAt = new Date('2026-09-20T00:00:00.000Z');
const t1 = new Date('2026-09-20T01:00:00.000Z');
const t2 = new Date('2026-09-20T02:00:00.000Z');
const invalidDate = new Date('not a date');
const dateLike = { getTime: () => createdAt.getTime() } as unknown as Date;

function create(overrides: Partial<{ name: unknown; slug: unknown; createdAt: Date }> = {}) {
  return Organization.create({
    id,
    name: 'Signal Arts',
    slug: 'signal-arts',
    createdAt,
    ...overrides,
  });
}

function active(): Organization {
  const result = create();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function restoreInput(
  overrides: Partial<RestoreOrganizationInput> = {},
): RestoreOrganizationInput {
  return {
    id,
    name: 'Signal Arts',
    slug: 'signal-arts',
    status: 'active',
    createdAt,
    updatedAt: t1,
    version: 3,
    ...overrides,
  };
}

function restored(status: OrganizationStatus, version = 3): Organization {
  const result = Organization.restore(restoreInput({ status, version }));
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function failureType(result: { ok: boolean; error?: { type: string } }) {
  expect(result.ok).toBe(false);
  return (result as { error: { type: string } }).error.type;
}

describe('Organization.create', () => {
  it('starts unsaved with updatedAt equal to createdAt and an invalid-kind failure contract', () => {
    const organization = active();
    expect(organization.id).toBe(id);
    expect(organization.version).toBe(0);
    expect(organization.updatedAt).toEqual(createdAt);

    const failed = create({ name: '' });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.kind).toBe('invalid');
  });

  it('rejects invalid or non-Date creation times', () => {
    expect(failureType(create({ createdAt: invalidDate }))).toBe(
      'organization.invalid_created_at',
    );
    expect(failureType(create({ createdAt: dateLike }))).toBe(
      'organization.invalid_created_at',
    );
  });

  it('checks the creation time before the name, and the name before the slug', () => {
    expect(
      failureType(create({ createdAt: invalidDate, name: 42, slug: 42 })),
    ).toBe('organization.invalid_created_at');
    expect(failureType(create({ name: 42, slug: 42 }))).toBe(
      'organization.invalid_name',
    );
  });

  it('rejects non-string, blank and overlong names', () => {
    expect(failureType(create({ name: 42 }))).toBe('organization.invalid_name');
    expect(failureType(create({ name: null }))).toBe('organization.invalid_name');
    expect(failureType(create({ name: '' }))).toBe('organization.invalid_name');
    expect(failureType(create({ name: '   ' }))).toBe('organization.invalid_name');
    expect(failureType(create({ name: 'x'.repeat(161) }))).toBe(
      'organization.invalid_name',
    );
  });

  it('accepts names at the length boundary after trimming', () => {
    const result = create({ name: `  ${'x'.repeat(160)}  ` });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe('x'.repeat(160));
    expect(create({ name: 'x' }).ok).toBe(true);
  });

  it('rejects non-string and malformed slugs', () => {
    for (const slug of [
      42,
      undefined,
      '',
      '1abc',
      '-abc',
      'abc!',
      '!abc',
      'ab_c',
      'a b',
      'a'.repeat(64),
    ]) {
      expect(failureType(create({ slug }))).toBe('organization.invalid_slug');
    }
  });

  it('accepts slugs at the boundaries of the pattern', () => {
    for (const slug of ['a', 'a1', 'a-b-9', 'z'.repeat(63), '  ABC  ']) {
      const result = create({ slug });
      expect(result.ok).toBe(true);
    }
    const upper = create({ slug: '  ABC-1 ' });
    if (upper.ok) expect(upper.value.slug).toBe('abc-1');
  });

  it('copies dates in and out so callers cannot mutate state', () => {
    const input = new Date(createdAt.getTime());
    const result = create({ createdAt: input });
    if (!result.ok) throw new Error(result.error.message);
    input.setTime(0);
    expect(result.value.createdAt).toEqual(createdAt);
    expect(result.value.updatedAt).toEqual(createdAt);

    result.value.createdAt.setTime(0);
    result.value.updatedAt.setTime(0);
    expect(result.value.createdAt).toEqual(createdAt);
    expect(result.value.updatedAt).toEqual(createdAt);
  });
});

describe('Organization.restore', () => {
  it('restores every known status with its stored version and normalized fields', () => {
    for (const status of ORGANIZATION_STATUSES) {
      const result = Organization.restore(
        restoreInput({ status, name: ' Signal ', slug: ' SIGNAL ' }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.id).toBe(id);
      expect(result.value.status).toBe(status);
      expect(result.value.version).toBe(3);
      expect(result.value.name).toBe('Signal');
      expect(result.value.slug).toBe('signal');
      expect(result.value.createdAt).toEqual(createdAt);
      expect(result.value.updatedAt).toEqual(t1);
    }
  });

  it('rejects unknown status, invalid dates and unstored versions as invalid state', () => {
    const cases: Partial<RestoreOrganizationInput>[] = [
      { status: 'deleted' as OrganizationStatus },
      { createdAt: invalidDate },
      { createdAt: dateLike },
      { updatedAt: invalidDate },
      { version: 0 },
      { version: 1.5 },
    ];
    for (const overrides of cases) {
      expect(failureType(Organization.restore(restoreInput(overrides)))).toBe(
        'organization.invalid_state',
      );
    }
  });

  it('accepts the first stored version', () => {
    expect(Organization.restore(restoreInput({ version: 1 })).ok).toBe(true);
  });

  it('rejects an update time before creation but allows equality', () => {
    expect(
      failureType(
        Organization.restore(
          restoreInput({ updatedAt: new Date(createdAt.getTime() - 1) }),
        ),
      ),
    ).toBe('organization.non_monotonic_time');
    expect(Organization.restore(restoreInput({ updatedAt: createdAt })).ok).toBe(
      true,
    );
  });

  it('validates name before slug', () => {
    expect(
      failureType(Organization.restore(restoreInput({ name: '', slug: '' }))),
    ).toBe('organization.invalid_name');
    expect(failureType(Organization.restore(restoreInput({ slug: '9' })))).toBe(
      'organization.invalid_slug',
    );
  });

  it('copies input dates', () => {
    const c = new Date(createdAt.getTime());
    const u = new Date(t1.getTime());
    const result = Organization.restore(restoreInput({ createdAt: c, updatedAt: u }));
    if (!result.ok) throw new Error(result.error.message);
    c.setTime(0);
    u.setTime(0);
    expect(result.value.createdAt).toEqual(createdAt);
    expect(result.value.updatedAt).toEqual(t1);
  });
});

describe('Organization.saved', () => {
  it('returns a new instance one version ahead with the same state', () => {
    const organization = restored('suspended', 4);
    const saved = organization.saved();
    expect(saved.version).toBe(5);
    expect(organization.version).toBe(4);
    expect(saved.status).toBe('suspended');
    expect(saved.name).toBe(organization.name);
    expect(saved.slug).toBe(organization.slug);
    expect(saved.updatedAt).toEqual(organization.updatedAt);
    expect(active().saved().version).toBe(1);
  });
});

describe('Organization transitions', () => {
  it('rename changes only the name and updatedAt and keeps the version', () => {
    const organization = restored('suspended', 7);
    const result = organization.rename('  New Name ', t2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('New Name');
    expect(result.value.slug).toBe('signal-arts');
    expect(result.value.status).toBe('suspended');
    expect(result.value.id).toBe(id);
    expect(result.value.createdAt).toEqual(createdAt);
    expect(result.value.updatedAt).toEqual(t2);
    expect(result.value.version).toBe(7);
    expect(organization.name).toBe('Signal Arts');
    expect(organization.updatedAt).toEqual(t1);
  });

  it('rename validates the new name', () => {
    expect(failureType(active().rename('', t1))).toBe('organization.invalid_name');
    expect(failureType(active().rename(5, t1))).toBe('organization.invalid_name');
  });

  it('rename checks time before the archived state, and the archived state before the name', () => {
    const archived = restored('archived');
    expect(failureType(archived.rename('X', invalidDate))).toBe(
      'organization.invalid_transition_time',
    );
    expect(failureType(archived.rename('', t2))).toBe('organization.archived');
  });

  it('suspend moves active to suspended and rejects other statuses', () => {
    const result = restored('active').suspend(t2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('suspended');
      expect(result.value.updatedAt).toEqual(t2);
      expect(result.value.version).toBe(3);
      expect(result.value.name).toBe('Signal Arts');
    }
    expect(failureType(restored('suspended').suspend(t2))).toBe(
      'organization.invalid_suspension',
    );
    expect(failureType(restored('archived').suspend(t2))).toBe(
      'organization.invalid_suspension',
    );
  });

  it('reactivate moves suspended to active and rejects other statuses', () => {
    const result = restored('suspended').reactivate(t2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('active');
      expect(result.value.updatedAt).toEqual(t2);
    }
    expect(failureType(restored('active').reactivate(t2))).toBe(
      'organization.invalid_reactivation',
    );
    expect(failureType(restored('archived').reactivate(t2))).toBe(
      'organization.invalid_reactivation',
    );
  });

  it('archive accepts active and suspended organizations once', () => {
    for (const status of ['active', 'suspended'] as const) {
      const result = restored(status).archive(t2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('archived');
        expect(result.value.updatedAt).toEqual(t2);
      }
    }
    expect(failureType(restored('archived').archive(t2))).toBe(
      'organization.already_archived',
    );
  });

  it('every transition rejects invalid and backwards times but allows the same instant', () => {
    const transitions: ((o: Organization, at: Date) => { ok: boolean })[] = [
      (o, at) => o.rename('Other', at),
      (o, at) => o.suspend(at),
      (o, at) => o.archive(at),
    ];
    for (const run of transitions) {
      const organization = restored('active');
      expect(failureType(run(organization, invalidDate) as never)).toBe(
        'organization.invalid_transition_time',
      );
      expect(failureType(run(organization, dateLike) as never)).toBe(
        'organization.invalid_transition_time',
      );
      expect(
        failureType(run(organization, new Date(t1.getTime() - 1)) as never),
      ).toBe('organization.non_monotonic_time');
      expect(run(organization, new Date(t1.getTime())).ok).toBe(true);
    }

    const suspended = restored('suspended');
    expect(failureType(suspended.reactivate(invalidDate))).toBe(
      'organization.invalid_transition_time',
    );
    expect(failureType(suspended.reactivate(new Date(t1.getTime() - 1)))).toBe(
      'organization.non_monotonic_time',
    );
    expect(suspended.reactivate(t1).ok).toBe(true);
  });

  it('checks transition time before status', () => {
    expect(failureType(restored('archived').archive(createdAt))).toBe(
      'organization.non_monotonic_time',
    );
    expect(failureType(restored('suspended').suspend(invalidDate))).toBe(
      'organization.invalid_transition_time',
    );
    expect(failureType(restored('active').reactivate(invalidDate))).toBe(
      'organization.invalid_transition_time',
    );
  });

  it('copies the transition time', () => {
    const at = new Date(t2.getTime());
    const result = active().suspend(at);
    if (!result.ok) throw new Error(result.error.message);
    at.setTime(0);
    expect(result.value.updatedAt).toEqual(t2);
  });
});
