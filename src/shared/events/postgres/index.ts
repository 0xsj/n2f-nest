/** PostgreSQL-backed outbox and mailbox adapters for the events seam. */
export {
  enqueue,
  Mailbox,
  baselineMigration,
  Store,
  type Lease,
  type OutboxStats,
} from './store.js';
