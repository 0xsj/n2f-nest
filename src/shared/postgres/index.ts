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

export function map(error: unknown): Failure {
  if (kindOf(error)) return fromCaught(error);
  if (error instanceof pg.DatabaseError) {
    if (['23505', '40001', '40P01'].includes(error.code ?? '')) {
      return failure('conflict', 'database operation failed', {
        type: 'database.conflict',
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

  /** Callback must await all work; the leased client must never escape its lifetime. */
  async transaction<T>(
    fn: (
      client: pg.PoolClient,
      signal: AbortSignal,
    ) => Promise<Result<T, Failure>>,
    signal?: AbortSignal,
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
      Math.max(1, this.budget - (performance.now() - started)),
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

  async migrate(
    migrations: readonly Migration[],
  ): Promise<Result<void, Failure>> {
    const entries = migrations.map((migration) => ({ ...migration }));
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

    return this.transaction(async (transaction) => {
      await transaction.query('SELECT pg_advisory_xact_lock(925005)');
      await transaction.query(
        'CREATE TABLE IF NOT EXISTS public.signals_migrations (version bigint PRIMARY KEY, checksum text NOT NULL)',
      );
      const rows = (
        await transaction.query<{ version: string; checksum: string }>(
          'SELECT version,checksum FROM public.signals_migrations ORDER BY version',
        )
      ).rows;
      if (rows.length > entries.length) return err(drift());
      for (const [index, migration] of entries.entries()) {
        const checksum = createHash('sha256')
          .update(migration.sql)
          .digest('hex');
        if (index < rows.length) {
          if (
            rows[index].version !== String(migration.version) ||
            rows[index].checksum !== checksum
          ) {
            return err(drift());
          }
        } else {
          await transaction.query(migration.sql);
          await transaction.query(
            'INSERT INTO public.signals_migrations(version,checksum) VALUES ($1,$2)',
            [migration.version, checksum],
          );
        }
      }
      return ok(undefined);
    });
  }
}
