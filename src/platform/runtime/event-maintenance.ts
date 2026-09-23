import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Inbox } from '../../shared/events/index.js';
import { Mailbox, Store as PostgresEventStore } from '../../shared/events/postgres/index.js';
import { EVENT_INBOX } from '../events/event-delivery.js';
import { RUNTIME_CONFIG, EVENT_OUTBOX } from './tokens.js';
import type { MetricsRegistry } from '../../shared/metrics/index.js';
import { METRICS } from '../metrics/metrics.tokens.js';
import type { RuntimeConfig } from './config.js';

const INTERVAL_MS = 10 * 60 * 1000;
const GAUGE_INTERVAL_MS = 30 * 1000;

/**
 * Reports event backlog as gauges (inbox pending and dead per consumer,
 * outbox rows and lag) every 30 seconds, and bounds the PostgreSQL outbox and
 * inbox. Sent outbox rows and fully processed
 * inbox events are deleted after the retention period; dead rows are kept for
 * an operator to requeue (`bun run events:requeue`). Deletion is batched and
 * idempotent, so every process may run it.
 */
@Injectable()
export class EventMaintenance implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('EventMaintenance');
  private timer?: ReturnType<typeof setInterval>;
  private gaugeTimer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private measuring?: Promise<void>;
  /** Backlog series reported last time, so one that empties drops to zero. */
  private reported = new Set<string>();

  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    @Inject(EVENT_OUTBOX) private readonly outbox: PostgresEventStore | undefined,
    @Inject(EVENT_INBOX) private readonly inbox: Inbox,
    @Inject(METRICS) private readonly metrics: MetricsRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const measure = () => {
      this.measuring ??= this.measure().finally(() => {
        this.measuring = undefined;
      });
    };
    measure();
    this.gaugeTimer = setInterval(measure, GAUGE_INTERVAL_MS);
    this.gaugeTimer.unref();
    if (!this.outbox && !(this.inbox instanceof Mailbox)) return;
    this.timer = setInterval(() => {
      this.running ??= this.prune().finally(() => {
        this.running = undefined;
      });
    }, INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
    await this.running;
    await this.measuring;
  }

  /** Refresh the backlog gauges from the inbox and outbox. */
  async measure(): Promise<void> {
    const backlog = await this.inbox.backlog();
    if (backlog.ok) {
      const current = new Set<string>();
      for (const row of backlog.value) {
        current.add(`${row.consumer}\u0000${row.state}`);
        this.metrics.set('n2f_event_inbox_backlog', { consumer: row.consumer, state: row.state }, row.count);
      }
      for (const key of this.reported) {
        if (current.has(key)) continue;
        const [consumer, state] = key.split('\u0000');
        this.metrics.set('n2f_event_inbox_backlog', { consumer: consumer!, state: state! }, 0);
      }
      this.reported = current;
    }
    if (!this.outbox) return;
    const stats = await this.outbox.stats();
    if (!stats.ok) return;
    this.metrics.set('n2f_event_outbox_rows', { state: 'pending' }, stats.value.pending);
    this.metrics.set('n2f_event_outbox_rows', { state: 'dead' }, stats.value.dead);
    this.metrics.set('n2f_event_outbox_oldest_pending_seconds', {}, stats.value.oldestPendingSeconds);
  }

  async prune(): Promise<void> {
    const retentionMs = this.config.eventRetentionHours * 3_600_000;
    const sent = this.outbox ? await this.outbox.prune(retentionMs) : undefined;
    const processed =
      this.inbox instanceof Mailbox ? await this.inbox.prune(retentionMs) : undefined;
    for (const [name, result] of [
      ['outbox', sent],
      ['inbox', processed],
    ] as const) {
      if (result && !result.ok) {
        this.logger.error(`${name} pruning failed: ${result.error.type ?? result.error.kind}`);
      } else if (result?.value) {
        this.logger.log(`pruned ${result.value} ${name} rows older than the retention period`);
      }
    }
  }
}
