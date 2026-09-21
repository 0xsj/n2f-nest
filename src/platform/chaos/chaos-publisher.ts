import { err, type Failure, type Result } from '../../shared/errors/index.js';
import type {
  Envelope,
  Publisher,
  Receipt,
} from '../../shared/events/index.js';
import { FaultInjector } from './fault-injector.js';

/** Generic Publisher wrapper for local, outbox and NATS delivery tests. */
export class ChaosPublisher implements Publisher {
  constructor(
    private readonly delegate: Publisher,
    private readonly faults: FaultInjector,
  ) {}

  async publish(
    event: Envelope,
    signal?: AbortSignal,
  ): Promise<Result<Receipt, Failure>> {
    const before = await this.faults.hit('publisher.publish.before', signal);
    if (!before.ok) return before;

    const result = await this.delegate.publish(event, signal);
    if (!result.ok) return result;

    const after = await this.faults.hit('publisher.publish.after', signal);
    return after.ok ? result : err(after.error);
  }
}
