/** pg handles belong to concrete infrastructure consumers, never domain contracts. */
export type { TransactionDatabase } from './transaction.js';
import { createHash } from 'node:crypto';
import pg from 'pg';
import {
  err,
  failure,
  fromCaught,
  kindOf,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';
import { SecretString } from '../secret/index.js';

export type Config = {
  url: SecretString;
  maxConnections: number;
  timeoutMs: number;
};

export type Migration = { version: number; sql: string };

/**
 * A completed migration history that was squashed into baselines. A database
 * whose `ledger` holds exactly `versions` rows, ending with `finalChecksum`,
 * already has the baseline schema: its baselines (versions up to
 * `baselineThrough`) are recorded as applied instead of run, and the old
 * ledger is dropped. Any other state of that ledger is refused.
 */
export type LegacyHistory = Readonly<{
  ledger: string;
  versions: number;
  finalChecksum: string;
  baselineThrough: number;
}>;

const invalid = () =>
  failure('invalid', 'invalid database configuration', {
    type: 'database.config',
  });
const timedOut = () =>
  failure('timeout', 'database operation timed out', {
    type: 'database.timeout',
  });
const uncertain = () =>
  failure('unavailable', 'database commit outcome uncertain', {
    type: 'database.commit_uncertain',
  });
const drift = () =>
  failure('conflict', 'migration history differs', {
    type: 'database.migration_drift',
  });

/**
 * Name the unique constraint a statement violated. Adapters use it to report
 * the domain conflict (a taken email or slug) instead of a generic one.
 */
export function violatedUnique(error: unknown): string | undefined {
  return error instanceof pg.DatabaseError && error.code === '23505'
    ? error.constraint
    : undefined;
}

/**
 * After a versioned UPDATE matched no row, tell a missing record from a read
 * that another writer has since superseded.
 */
export async function missingOrStale(
  client: pg.PoolClient,
  table: string,
  id: string,
): Promise<'missing' | 'stale'> {
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(table)) {
    throw new TypeError('table must be a qualified identifier');
  }
  const result = await client.query(
    `SELECT 1 FROM ${table} WHERE id=$1::uuid`,
    [id],
  );
  return result.rowCount === 0 ? 'missing' : 'stale';
}

export function map(error: unknown): Failure {
  if (kindOf(error)) return fromCaught(error);
  if (error instanceof pg.DatabaseError) {
    if (error.code === '23505') {
      return failure('conflict', 'database operation failed', {
        type: 'database.conflict',
      });
    }
    // Serialization failures and deadlocks say nothing about the request; the
    // same operation can succeed when retried.
    if (error.code === '40001' || error.code === '40P01') {
      return failure('unavailable', 'database operation was not serializable', {
        type: 'database.serialization',
      });
    }
    if (error.code === '57014') return timedOut();
    return failure('internal', 'database operation failed', {
      type: 'database.failed',
    });
  }
  return failure('unavailable', 'database operation failed', {
    type: 'database.unavailable',
  });
}

export function commitFailure(error: unknown): Failure {
  return error instanceof pg.DatabaseError ? map(error) : uncertain();
}

export class Database {
  #closing?: Promise<void>;
  #active = new Set<pg.PoolClient>();

  private constructor(
    private readonly pool: pg.Pool,
    private readonly budget: number,
  ) {
    // Idle socket failures are contained. Operation owners observe safe results.
    pool.on('error', () => {});
  }

  static async open(config: Config): Promise<Result<Database, Failure>> {
    try {
      const url = new URL(config.url.reveal());
      if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        !url.hostname ||
        url.hash ||
        !Number.isInteger(config.maxConnections) ||
        config.maxConnections < 1 ||
        config.maxConnections > 64 ||
        !Number.isInteger(config.timeoutMs) ||
        config.timeoutMs < 1 ||
        config.timeoutMs > 30000
      ) {
        return err(invalid());
      }
    } catch {
      return err(invalid());
    }

    const pool = new pg.Pool({
      connectionString: config.url.reveal(),
      max: config.maxConnections,
      connectionTimeoutMillis: config.timeoutMs,
      idleTimeoutMillis: 30000,
      statement_timeout: config.timeoutMs,
      idle_in_transaction_session_timeout: config.timeoutMs,
      query_timeout: config.timeoutMs,
    });
    const database = new Database(pool, config.timeoutMs);
    const ping = await database.ping();
    if (!ping.ok) {
      await database.close(config.timeoutMs);
      return ping;
    }
    return ok(database);
  }

  async ping(signal?: AbortSignal): Promise<Result<void, Failure>> {
    return this.transaction(async (transaction) => {
      await transaction.query('SELECT 1');
      return ok(undefined);
    }, signal);
  }

  /**
   * Callback must await all work; the leased client must never escape its
   * lifetime. `budgetMs` overrides the configured operation budget for work
   * known to be long, such as migrations.
   */
  async transaction<T>(
    fn: (
      client: pg.PoolClient,
      signal: AbortSignal,
    ) => Promise<Result<T, Failure>>,
    signal?: AbortSignal,
    budgetMs: number = this.budget,
  ): Promise<Result<T, Failure>> {
    if (this.#closing) {
      return err(
        failure('unavailable', 'database closed', { type: 'database.closed' }),
      );
    }
    if (signal?.aborted) {
      return err(
        failure('canceled', 'database operation canceled', {
          type: 'database.canceled',
        }),
      );
    }

    const started = performance.now();
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      return err(map(error));
    }
    this.#active.add(client);
    let released = false;
    let committing = false;
    const release = (destroy = false) => {
      if (!released) {
        released = true;
        this.#active.delete(client);
        client.release(destroy);
      }
    };
    const controller = new AbortController();
    let cancel!: (result: Result<T, Failure>) => void;
    const stopped = new Promise<Result<T, Failure>>((resolve) => {
      cancel = resolve;
    });
    const stop = (canceled: boolean) => {
      controller.abort();
      release(true);
      cancel(
        err(
          committing
            ? uncertain()
            : canceled
              ? failure('canceled', 'database operation canceled', {
                  type: 'database.canceled',
                })
              : timedOut(),
        ),
      );
    };
    const timer = setTimeout(
      () => stop(false),
      Math.max(1, budgetMs - (performance.now() - started)),
    );
    const onAbort = () => stop(true);
    signal?.addEventListener('abort', onAbort, { once: true });
    const operation = (async (): Promise<Result<T, Failure>> => {
      try {
        if (signal?.aborted) {
          stop(true);
          return await stopped;
        }
        await client.query('BEGIN');
        const value = await fn(client, controller.signal);
        if (controller.signal.aborted) return await stopped;
        if (!value.ok) {
          await client.query('ROLLBACK');
          return value;
        }
        committing = true;
        const receipt = await client.query('COMMIT');
        if (receipt.command !== 'COMMIT') {
          return err(
            failure('internal', 'database transaction aborted', {
              type: 'database.failed',
            }),
          );
        }
        return value;
      } catch (error) {
        release(true);
        return err(committing ? commitFailure(error) : map(error));
      } finally {
        release();
      }
    })();
    try {
      return await Promise.race([operation, stopped]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async close(budgetMs: number): Promise<Result<void, Failure>> {
    this.#closing ??= this.pool.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.#closing.then(() => ok(undefined)),
        new Promise<Result<void, Failure>>((resolve) => {
          timer = setTimeout(
            () => resolve(err(timedOut())),
            Math.max(1, Math.min(budgetMs, this.budget)),
          );
        }),
      ]);
    } catch {
      return err(
        failure('unavailable', 'database close failed', {
          type: 'database.close',
        }),
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Apply pending migrations in one transaction under their own budget: a
   * migration may rebuild an index or wait for another process's migration
   * lock, which the ordinary operation budget would cut short.
   */
  async migrate(
    migrations: readonly Migration[],
    budgetMs = 120_000,
    legacy?: LegacyHistory,
  ): Promise<Result<void, Failure>> {
    if (!Number.isInteger(budgetMs) || budgetMs < 1) return err(invalid());
    if (legacy && !/^[a-z_][a-z0-9_]*$/.test(legacy.ledger)) return err(invalid());
    const entries = migrations.map((migration) => ({
      ...migration,
      checksum: createHash('sha256').update(migration.sql).digest('hex'),
    }));
    let previous = 0;
    for (const migration of entries) {
      if (
        !Number.isSafeInteger(migration.version) ||
        migration.version <= previous ||
        !migration.sql
      ) {
        return err(invalid());
      }
      previous = migration.version;
    }

    let transaction!: pg.PoolClient;
    const long = (text: string, values?: unknown[]) =>
      transaction.query({ text, values, query_timeout: budgetMs } as pg.QueryConfig);
    return this.transaction(async (client) => {
      transaction = client;
      await client.query(`SET LOCAL statement_timeout = ${budgetMs}`);
      await client.query(`SET LOCAL lock_timeout = ${budgetMs}`);
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${budgetMs}`);
      await long('SELECT pg_advisory_xact_lock(925005)');
      await client.query(
        'CREATE TABLE IF NOT EXISTS public.n2f_migrations (version bigint PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())',
      );
      let rows = (
        await client.query<{ version: string; checksum: string }>(
          'SELECT version,checksum FROM public.n2f_migrations ORDER BY version',
        )
      ).rows;

      if (rows.length === 0 && legacy) {
        const adopted = await this.adopt(client, legacy, entries);
        if (!adopted.ok) return adopted;
        rows = adopted.value;
      }

      if (rows.length > entries.length) return err(drift());
      for (const [index, migration] of entries.entries()) {
        if (index < rows.length) {
          if (
            rows[index].version !== String(migration.version) ||
            rows[index].checksum !== migration.checksum
          ) {
            return err(drift());
          }
        } else {
          await long(migration.sql);
          await client.query(
            'INSERT INTO public.n2f_migrations(version,checksum) VALUES ($1,$2)',
            [migration.version, migration.checksum],
          );
        }
      }
      return ok(undefined);
    }, undefined, budgetMs);
  }

  /** Record a completed legacy history as its baselines; see `LegacyHistory`. */
  private async adopt(
    client: pg.PoolClient,
    legacy: LegacyHistory,
    entries: ReadonlyArray<Migration & { checksum: string }>,
  ): Promise<Result<{ version: string; checksum: string }[], Failure>> {
    const exists = (
      await client.query<{ present: boolean }>(
        'SELECT to_regclass($1) IS NOT NULL AS present',
        [`public.${legacy.ledger}`],
      )
    ).rows[0]?.present;
    if (!exists) return ok([]);

    const history = (
      await client.query<{ count: string; last: string | null; checksum: string | null }>(
        `SELECT count(*) AS count, max(version) AS last,
                (SELECT checksum FROM public.${legacy.ledger} ORDER BY version DESC LIMIT 1) AS checksum
           FROM public.${legacy.ledger}`,
      )
    ).rows[0];
    if (
      Number(history?.count) !== legacy.versions ||
      Number(history?.last) !== legacy.versions ||
      history?.checksum !== legacy.finalChecksum
    ) {
      return err(
        failure('conflict', 'database predates the migration baseline', {
          type: 'database.legacy_history',
          fields: { ledger: legacy.ledger },
        }),
      );
    }

    const baselines = entries.filter((entry) => entry.version <= legacy.baselineThrough);
    for (const baseline of baselines) {
      await client.query('INSERT INTO public.n2f_migrations(version,checksum) VALUES ($1,$2)', [
        baseline.version,
        baseline.checksum,
      ]);
    }
    await client.query(`DROP TABLE public.${legacy.ledger}`);
    return ok(baselines.map((baseline) => ({ version: String(baseline.version), checksum: baseline.checksum })));
  }

}
