import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretString } from '../secret/index.js';
import { Database } from './index.js';

/**
 * Migrations run under their own budget (hardening item R9). Each case uses a
 * throwaway database so the migration ledger starts empty. Needs a disposable
 * PostgreSQL where the configured user may create databases.
 */
const url = process.env.N2F_DATABASE_URL;
const enabled = process.env.N2F_RUN_POSTGRES_INTEGRATION === '1' && url !== undefined;

(enabled ? describe : describe.skip)('Database.migrate', () => {
  const created: string[] = [];

  async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await run(client);
    } finally {
      await client.end();
    }
  }

  /** A fresh database opened with a deliberately short operation budget. */
  async function scratch(): Promise<Database> {
    const name = `n2f_migrate_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await admin((client) => client.query(`CREATE DATABASE ${name}`));
    created.push(name);
    const target = new URL(url!);
    target.pathname = `/${name}`;
    const opened = await Database.open({
      url: new SecretString(target.toString()),
      maxConnections: 4,
      timeoutMs: 500,
    });
    if (!opened.ok) throw new Error(opened.error.message);
    return opened.value;
  }

  beforeAll(() => {
    expect(url).toBeDefined();
  });

  afterAll(async () => {
    await admin(async (client) => {
      for (const name of created) await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    });
  });

  it('lets a migration outlast the ordinary operation budget', async () => {
    const database = await scratch();
    try {
      const migrated = await database.migrate([{ version: 1, sql: 'SELECT pg_sleep(1.2)' }], 10_000);
      expect(migrated).toEqual({ ok: true, value: undefined });
    } finally {
      await database.close(1000);
    }
  });

  it('fails a migration that exceeds the migration budget', async () => {
    const database = await scratch();
    try {
      const migrated = await database.migrate([{ version: 1, sql: 'SELECT pg_sleep(3)' }], 1000);
      expect(migrated.ok).toBe(false);
    } finally {
      await database.close(1000);
    }
  });

  it('serializes concurrent migrations; the waiter succeeds past the operation budget', async () => {
    const first = await scratch();
    const target = new URL(url!);
    target.pathname = `/${created.at(-1)}`;
    const opened = await Database.open({ url: new SecretString(target.toString()), maxConnections: 4, timeoutMs: 500 });
    if (!opened.ok) throw new Error(opened.error.message);
    const second = opened.value;
    const migrations = [
      { version: 1, sql: 'CREATE TABLE migrated (id int PRIMARY KEY)' },
      { version: 2, sql: 'SELECT pg_sleep(1.2)' },
    ];
    try {
      const [a, b] = await Promise.all([first.migrate(migrations, 10_000), second.migrate(migrations, 10_000)]);
      expect(a).toEqual({ ok: true, value: undefined });
      expect(b).toEqual({ ok: true, value: undefined });
    } finally {
      await first.close(1000);
      await second.close(1000);
    }
  });
});
