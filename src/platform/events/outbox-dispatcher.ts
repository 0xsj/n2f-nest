import type {
  Failure,
  Result,
} from '../../shared/errors/index.js';
import type { ID, IDGenerator } from '../../shared/id/index.js';
import type {
  Publisher,
} from '../../shared/events/index.js';

/** The narrow capability required by a durable outbox coordinator. */
export interface OutboxStore {
  dispatch(
    publisher: Publisher,
    token: ID,
    signal?: AbortSignal,
  ): Promise<Result<boolean, Failure>>;
}

/**
 * Coordinates one durable outbox delivery attempt.
 *
 * Lease ownership, retry state and acknowledgement remain in the store. This
 * class only supplies an attempt token and the publisher, which keeps the
 * process lifecycle independent from PostgreSQL and NATS implementations.
 */
export class OutboxDispatcher {
  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: Publisher,
    private readonly ids: IDGenerator,
  ) {}

  dispatchOnce(signal?: AbortSignal): Promise<Result<boolean, Failure>> {
    const token = this.ids.newId();
    if (!token.ok) return Promise.resolve(token);
    return this.store.dispatch(this.publisher, token.value, signal);
  }
}
