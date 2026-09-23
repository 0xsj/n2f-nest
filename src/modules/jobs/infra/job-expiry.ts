import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Reader, os } from '../../../shared/env/index.js';
import {
  actor,
  attribution,
  Factory as ProvenanceFactory,
  operation,
} from '../../../shared/provenance/index.js';
import { ExpireStaleJobs } from '../app/index.js';

const INTERVAL_MS = 60 * 1000;
const BATCH = 100;

export const JOB_EXPIRY_TIMEOUT = Symbol('jobs.expiry.runningTimeoutMs');

/**
 * `N2F_JOB_RUNNING_TIMEOUT_MINUTES` (default 60): how long a job may stay
 * running before it is failed with `job.timed_out`. Invalid values stop
 * startup rather than disable the reaper.
 */
export function runningTimeoutMs(): number {
  const source = os();
  if (!source.ok) throw new Error(source.error.message);
  const reader = new Reader(source.value);
  const minutes = reader.int('N2F_JOB_RUNNING_TIMEOUT_MINUTES', 60, 1, 10080);
  const valid = reader.check();
  if (!valid.ok) {
    throw new Error(`invalid configuration: ${Object.keys(valid.error.fields ?? {}).join(', ')}`);
  }
  return minutes * 60 * 1000;
}

/** Periodically fails jobs left running past the timeout (see ExpireStaleJobs). */
@Injectable()
export class JobExpiry implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('JobExpiry');
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private readonly abort = new AbortController();

  constructor(
    private readonly expire: ExpireStaleJobs,
    private readonly factory: ProvenanceFactory,
    @Inject(JOB_EXPIRY_TIMEOUT) private readonly timeoutMs: number,
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

  async sweep(): Promise<void> {
    const work = this.work();
    if (!work.ok) {
      this.logger.error(`job expiry could not open work: ${work.error.type ?? work.error.kind}`);
      return;
    }
    const result = await this.expire.execute({
      runningTimeoutMs: this.timeoutMs,
      limit: BATCH,
      work: work.value,
      signal: this.abort.signal,
    });
    if (!result.ok) {
      this.logger.error(`job expiry failed: ${result.error.type}`);
    } else if (result.value.expired > 0) {
      this.logger.warn(`failed ${result.value.expired} job(s) left running past the timeout`);
    }
  }

  private work() {
    const operationValue = operation('job.expire');
    if (!operationValue.ok) return operationValue;
    const executor = actor('service', 'n2f-nest-job-expiry');
    if (!executor.ok) return executor;
    const attributionValue = attribution({ initiator: executor.value });
    if (!attributionValue.ok) return attributionValue;
    const scope = this.factory.open({
      origin: 'schedule',
      operation: operationValue.value,
      attribution: attributionValue.value,
      executor: executor.value,
    });
    return scope.ok ? { ok: true as const, value: scope.value.workContext() } : scope;
  }
}
