import { describe, expect, it } from 'vitest';
import { CreateOrganization, ListOrganizations, type CreateOrganizationRecord } from './index.js';
import { parse, type ID } from '../../../shared/id/index.js';
import type { Failure, Result } from '../../../shared/errors/index.js';

const value = <T>(result: Result<T, Failure>): T => { if (!result.ok) throw Error(result.error.type); return result.value; };
const id = (suffix: string): ID => value(parse(`00000000-0000-4000-8000-000000000${suffix}`));
const errorType = <T>(result: Result<T, Failure>) => result.ok ? undefined : result.error.type;

const base = (eligible: boolean, outcome: 'created' | 'already_exists' = 'created') => {
  const ids = [id('010'), id('011')];
  let idCalls = 0;
  let stored: CreateOrganizationRecord | undefined;
  return {
    ids: { newId: () => ({ ok: true, value: ids[idCalls++] }) as Result<ID, Failure> },
    clock: { now: () => new Date(1000) },
    eligibility: { checkActive: async () => ({ ok: true, value: { eligible } }) as Result<{ eligible: boolean }, Failure> },
    store: { createOrganization: async (record: CreateOrganizationRecord) => { stored = record; return { ok: true, value: outcome } as Result<typeof outcome, Failure>; } },
    calls: () => ({ idCalls, stored }),
  };
};

describe('organization application', () => {
  it('checks eligibility and sends both validated values to one store call', async () => {
    const ports = base(true);
    const operation = value(CreateOrganization.create(ports));
    const result = value(await operation.execute({ name: ' Team 🌱 ', ownerPrincipalId: id('012') }));
    expect(result.organization.id).toBe(id('010'));
    expect(result.owner.id).toBe(id('011'));
    expect(result.owner.role).toBe('owner');
    expect(ports.calls().idCalls).toBe(2);
    expect(ports.calls().stored).toEqual(result);
  });
  it('refuses an ineligible owner before allocating or writing', async () => {
    const ports = base(false);
    const operation = value(CreateOrganization.create(ports));
    const result = await operation.execute({ name: 'Team', ownerPrincipalId: id('012') });
    expect(errorType(result)).toBe('org.principal_ineligible');
    expect(ports.calls().idCalls).toBe(0);
    expect(ports.calls().stored).toBeUndefined();
  });
  it('maps the expected duplicate outcome to conflict', async () => {
    const ports = base(true, 'already_exists');
    const operation = value(CreateOrganization.create(ports));
    const result = await operation.execute({ name: 'Team', ownerPrincipalId: id('012') });
    expect(errorType(result)).toBe('org.organization_exists');
  });
  it('scopes reads to the admitted principal and bounded limit', async () => {
    let seen: { principalId: ID; limit: number } | undefined;
    const operation = value(ListOrganizations.create({
      listForPrincipal: async (principalId, limit) => {
        seen = { principalId, limit };
        return { ok: true, value: [] } as Result<never[], Failure>;
      },
    }));
    expect(value(await operation.execute(id('012'), 25))).toEqual([]);
    expect(seen).toEqual({ principalId: id('012'), limit: 25 });
    expect((await operation.execute(id('012'), 101)).ok).toBe(false);
  });
});
