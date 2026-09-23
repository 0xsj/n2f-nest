import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PruneSessions } from '../app/index.js';
import { SESSION_SETTINGS, type SessionSettings } from './session-settings.js';

const INTERVAL_MS = 10 * 60 * 1000;
const BATCH = 1000;

/**
 * Periodically deletes sessions that ended more than
 * `N2F_SESSION_RETENTION_DAYS` ago (see PruneSessions), a batch at a time
 * until none remain.
 */
@Injectable()
export class SessionPruning implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('SessionPruning');
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<number>;
  private readonly abort = new AbortController();

  constructor(
    private readonly prune: PruneSessions,
    @Inject(SESSION_SETTINGS) private readonly settings: SessionSettings,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.running ??= this.sweep().finally(() => {
        this.running = undefined;
      });
    }, INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    await this.running;
  }

  /** Prune until a batch comes back short; returns how many were deleted. */
  async sweep(): Promise<number> {
    let total = 0;
    while (!this.abort.signal.aborted) {
      const result = await this.prune.execute({
        retentionMs: this.settings.retentionMs,
        limit: BATCH,
        signal: this.abort.signal,
      });
      if (!result.ok) {
        this.logger.error(`session pruning failed: ${result.error.type}`);
        break;
      }
      total += result.value.pruned;
      if (result.value.pruned < BATCH) break;
    }
    if (total > 0) this.logger.log(`pruned ${total} ended session(s)`);
    return total;
  }
}
