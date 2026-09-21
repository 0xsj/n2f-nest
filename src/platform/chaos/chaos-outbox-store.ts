import { err, type Failure, type Result } from '../../shared/errors/index.js';
import type { ID } from '../../shared/id/index.js';
import type { OutboxStore } from '../events/outbox-dispatcher.js';
import type { Publisher } from '../../shared/events/index.js';
import { FaultInjector } from './fault-injector.js';

/** Outbox coordinator wrapper for lease, dispatch and acknowledgement faults. */
export class ChaosOutboxStore implements OutboxStore {
  constructor(
    private readonly delegate: OutboxStore,
    private readonly faults: FaultInjector,
  ) {}

  async dispatch(
    publisher: Publisher,
    token: ID,
    signal?: AbortSignal,
  ): Promise<Result<boolean, Failure>> {
    const before = await this.faults.hit('outbox.dispatch.before', signal);
    if (!before.ok) return before;

    const result = await this.delegate.dispatch(publisher, token, signal);
    if (!result.ok) return result;

    const after = await this.faults.hit('outbox.dispatch.after', signal);
    return after.ok ? result : err(after.error);
  }
}
