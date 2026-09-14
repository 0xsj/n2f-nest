import { describe, expect, it } from 'vitest';
import { migration, Store } from './index.js';
import { migration as eventsMigration } from '../../../../shared/events/postgres/store.js';
import { Database } from '../../../../shared/postgres/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import { Membership, Organization } from '../../domain/index.js';

const url = process.env.N2F_TEST_DATABASE_URL;
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { type?: string } }): T => {
  if (!result.ok) throw Error(result.error.type);
  return result.value;
};
const id = (suffix: string): ID => value(parse(`00000000-0000-4000-8000-000000000${suffix}`));

describe.skipIf(!url)('organization PostgreSQL store', () => {
  it('writes both rows atomically and maps duplicate IDs', async () => {
    const database = value(await Database.open({ url: new SecretString(url!), maxConnections: 4, timeoutMs: 5000 }));
    try {
      value(await database.migrate([eventsMigration(1), migration(6)]));
      const store = new Store(database);
      const organization = value(Organization.create(id('061'), 'Persistence Team', 1000));
      const owner = value(Membership.owner(id('062'), id('061'), id('063'), 1000));
      const record = { organization: organization.snapshot(), owner: owner.snapshot() };
      expect(value(await store.createOrganization(record))).toBe('created');
      expect(value(await store.createOrganization(record))).toBe('already_exists');
      const counts = value(await database.transaction(async (tx) => {
        const organizations = await tx.query<{ count: string }>('SELECT count(*) FROM public.n2f_org_organizations');
        const memberships = await tx.query<{ count: string }>('SELECT count(*) FROM public.n2f_org_memberships');
        return { ok: true, value: { organizations: Number(organizations.rows[0].count), memberships: Number(memberships.rows[0].count) } } as const;
      }));
      expect(counts).toEqual({ organizations: 1, memberships: 1 });
    } finally {
      await database.close(5000);
    }
  });
});
