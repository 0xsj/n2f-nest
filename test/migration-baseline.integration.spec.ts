import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { appMigrations, legacyHistory } from '../src/app/migrations.js';
import { Database } from '../src/shared/postgres/index.js';
import { SecretString } from '../src/shared/secret/index.js';

/**
 * The squashed baselines are equivalent to the history they replaced: a
 * database that applied the whole legacy history, once adopted, has exactly
 * the schema a fresh database gets. Each case uses throwaway databases.
 */
const url = process.env.N2F_DATABASE_URL;
const enabled = process.env.N2F_RUN_POSTGRES_INTEGRATION === '1' && url !== undefined;
const legacySchema = readFileSync(new URL('./fixtures/legacy-schema-v26.sql', import.meta.url), 'utf8');

(enabled ? describe : describe.skip)('Migration baseline', () => {
  const created: string[] = [];

  async function connect(database?: string): Promise<pg.Client> {
    const target = new URL(url!);
    if (database) target.pathname = `/${database}`;
    const client = new pg.Client({ connectionString: target.toString() });
    await client.connect();
    return client;
  }

  async function scratch(): Promise<string> {
    const name = `n2f_baseline_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const admin = await connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    created.push(name);
    return name;
  }

  /** Restore the legacy schema and a ledger with `versions` entries. */
  async function legacy(name: string, versions: number): Promise<void> {
    const client = await connect(name);
    await client.query(legacySchema);
    for (let version = 1; version <= versions; version += 1) {
      await client.query('INSERT INTO public.signals_migrations(version,checksum) VALUES ($1,$2)', [
        version,
        version === versions ? legacyHistory.finalChecksum : `legacy-${version}`,
      ]);
    }
    await client.end();
  }

  async function migrate(name: string) {
    const target = new URL(url!);
    target.pathname = `/${name}`;
    const opened = await Database.open({ url: new SecretString(target.toString()), maxConnections: 2, timeoutMs: 5000 });
    if (!opened.ok) throw new Error(opened.error.message);
    try {
      return await opened.value.migrate(appMigrations, 60_000, legacyHistory);
    } finally {
      await opened.value.close(1000);
    }
  }

  /** Columns, constraints and indexes of the public schema, ledger excluded. */
  async function schema(name: string): Promise<string[]> {
    const client = await connect(name);
    const rows = await client.query<{ line: string }>(`
      SELECT format('column %s.%s %s null=%s default=%s', table_name, column_name, data_type,
                    is_nullable, coalesce(column_default, '')) AS line
        FROM information_schema.columns
       WHERE table_schema='public' AND table_name <> 'n2f_migrations'
      UNION ALL
      SELECT format('constraint %s %s %s', conrelid::regclass, conname, pg_get_constraintdef(oid))
        FROM pg_constraint
       WHERE connamespace='public'::regnamespace AND conrelid::regclass::text <> 'n2f_migrations'
      UNION ALL
      SELECT format('index %s', indexdef)
        FROM pg_indexes
       WHERE schemaname='public' AND tablename <> 'n2f_migrations'
      ORDER BY 1`);
    await client.end();
    return rows.rows.map((row) => row.line);
  }

  async function ledger(name: string): Promise<{ tables: string[]; versions: string[] }> {
    const client = await connect(name);
    try {
      const tables = (
        await client.query<{ name: string }>(
          "SELECT tablename AS name FROM pg_tables WHERE schemaname='public' AND tablename LIKE '%migrations' ORDER BY 1",
        )
      ).rows.map((row) => row.name);
      const versions = tables.includes('n2f_migrations')
        ? (
            await client.query<{ version: string }>(
              'SELECT version::text FROM public.n2f_migrations ORDER BY version',
            )
          ).rows.map((row) => row.version)
        : [];
      return { tables, versions };
    } finally {
      await client.end();
    }
  }

  afterAll(async () => {
    const admin = await connect();
    for (const name of created) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it('adopts a database that applied the whole legacy history, leaving it identical to a fresh one', async () => {
    const fresh = await scratch();
    const adopted = await scratch();
    await legacy(adopted, legacyHistory.versions);

    expect(await migrate(fresh)).toEqual({ ok: true, value: undefined });
    expect(await migrate(adopted)).toEqual({ ok: true, value: undefined });

    const expected = await schema(fresh);
    expect(expected.length).toBeGreaterThan(100);
    expect(await schema(adopted)).toEqual(expected);
    expect(await ledger(adopted)).toEqual({
      tables: ['n2f_migrations'],
      versions: appMigrations.map((migration) => String(migration.version)),
    });
    // A second start finds nothing to do.
    expect(await migrate(adopted)).toEqual({ ok: true, value: undefined });
  });

  it('refuses a database with only part of the legacy history', async () => {
    const partial = await scratch();
    await legacy(partial, 14);

    expect(await migrate(partial)).toMatchObject({
      ok: false,
      error: { type: 'database.legacy_history' },
    });
    // Nothing changed: the refusal rolled back, the legacy ledger remains.
    expect(await ledger(partial)).toEqual({ tables: ['signals_migrations'], versions: [] });
  });
});
