import type pg from 'pg';
import type { Failure, Result } from '../errors/index.js';

/** Narrow transaction capability shared by concrete module adapters. */
export interface TransactionDatabase {
  transaction<T>(
    fn: (
      transaction: pg.PoolClient,
      signal: AbortSignal,
    ) => Promise<Result<T, Failure>>,
    signal?: AbortSignal,
  ): Promise<Result<T, Failure>>;
}
