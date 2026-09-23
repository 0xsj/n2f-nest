import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe } from 'vitest';
import { appMigrations } from '../../src/app/migrations.js';
import { SystemClock } from '../../src/shared/clock/index.js';
import { Envelope } from '../../src/shared/events/index.js';
import { V7, type ID } from '../../src/shared/id/index.js';
import { Database } from '../../src/shared/postgres/index.js';
import {
  anonymous,
  attribution,
  operation,
  restoreWork,
  type WorkContext,
} from '../../src/shared/provenance/index.js';
import { SecretString } from '../../src/shared/secret/index.js';

/**
 * Helpers for adapter contract specs: one behavioral suite run against every
 * storage adapter of a module. The in-memory run always executes; the
 * PostgreSQL run needs `N2F_RUN_POSTGRES_INTEGRATION=1` and a disposable
 * `N2F_DATABASE_URL`.
 */
const ids = new V7(new SystemClock());

export const HOUR = 3600 * 1000;

export function newId(): ID {
  const id = ids.newId();
  if (!id.ok) throw new Error(id.error.message);
  return id.value;
}

export function value<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

export function work(name: string): WorkContext {
  return value(
    restoreWork({
      workId: newId(),
      correlationId: newId(),
      correlationSource: 'local',
      operation: value(operation(name)),
      attribution: value(attribution({ initiator: anonymous() })),
      origin: 'request',
    }),
  );
}

/** Events created by contract specs; their outbox rows are removed afterwards. */
const createdEvents = new Set<string>();

export function event(
  type: string,
  context: WorkContext,
  payload: Record<string, unknown> = { id: newId() },
): Envelope {
  const created = value(Envelope.create(newId(), type, Date.now(), context, payload));
  createdEvents.add(created.id);
  return created;
}

/**
 * Run `suite` against PostgreSQL adapters built from a migrated database, or
 * skip it when no disposable database is configured.
 */
export function postgresContract<A>(
  build: (database: Database) => A,
  suite: (adapters: () => A) => void,
  options: Readonly<{
    /**
     * Run in a throwaway database instead of the shared one. Needed where a
     * suite claims "the next due row" (outbox, inbox), which other suites'
     * live workers would otherwise take or be starved of.
     */
    isolated?: boolean;
  }> = {},
): void {
  const url = process.env.N2F_DATABASE_URL;
  const enabled = process.env.N2F_RUN_POSTGRES_INTEGRATION === '1' && url !== undefined;

  (enabled ? describe : describe.skip)('PostgreSQL contract', () => {
    let database: Database | undefined;
    let adapters: A | undefined;
    let scratch: string | undefined;

    async function admin(sql: string): Promise<void> {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        await client.query(sql);
      } finally {
        await client.end();
      }
    }

    beforeAll(async () => {
      let target = url ?? '';
      if (options.isolated) {
        scratch = `n2f_contract_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
        await admin(`CREATE DATABASE ${scratch}`);
        const scratchUrl = new URL(target);
        scratchUrl.pathname = `/${scratch}`;
        target = scratchUrl.toString();
      }
      database = value(
        await Database.open({
          url: new SecretString(target),
          maxConnections: 4,
          timeoutMs: 5000,
        }),
      );
      value(await database.migrate(appMigrations));
      adapters = build(database);
    });

    afterAll(async () => {
      if (scratch) {
        await database?.close(5000);
        await admin(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
        return;
      }
      // Writers enqueue their events, but no dispatcher runs here. Remove the
      // rows (and any inbox copies) so they neither reach real consumers nor
      // precede another test's fixture.
      await database?.transaction(async (transaction) => {
        const ids = [[...createdEvents]];
        await transaction.query('DELETE FROM public.n2f_outbox WHERE event_id = ANY($1::uuid[])', ids);
        await transaction.query('DELETE FROM public.n2f_mailbox WHERE event_id = ANY($1::uuid[])', ids);
        return { ok: true, value: undefined };
      });
      await database?.close(5000);
    });

    suite(() => {
      if (!adapters) throw new Error('PostgreSQL adapters were not initialized');
      return adapters;
    });
  });
}
