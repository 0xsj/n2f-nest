import { err, type Failure, type Result } from '../../shared/errors/index.js';
import type { TransactionDatabase } from '../../shared/postgres/index.js';
import type pg from 'pg';
import { FaultInjector } from './fault-injector.js';

/** Transaction boundary wrapper for rollback, timeout and uncertain-result tests. */
export class ChaosTransactionDatabase implements TransactionDatabase {
  constructor(
    private readonly delegate: TransactionDatabase,
    private readonly faults: FaultInjector,
  ) {}

  async transaction<T>(
    fn: (
      transaction: pg.PoolClient,
      signal: AbortSignal,
    ) => Promise<Result<T, Failure>>,
    signal?: AbortSignal,
  ): Promise<Result<T, Failure>> {
    const before = await this.faults.hit('database.transaction.before', signal);
    if (!before.ok) return before;

    const result = await this.delegate.transaction(fn, signal);
    if (!result.ok) return result;

    const after = await this.faults.hit('database.transaction.after', signal);
    return after.ok ? result : err(after.error);
  }
}
