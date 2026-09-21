import {
  Injectable,
  Inject,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  EVENT_BUS,
  type EventBus,
} from '../../../../platform/events/event-bus.js';
import { RecordAuditEvent } from '../../app/index.js';

@Injectable()
export class AuditEventSubscription implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('AuditEvents');
  private unsubscribe: (() => void) | undefined;

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    private readonly record: RecordAuditEvent,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe(async (event, signal) => {
      const result = await this.record.execute({ event, signal });
      if (!result.ok) {
        this.logger.error(
          `failed to record ${event.type}: ${result.error.type}`,
        );
      }
      return result.ok ? { ok: true, value: undefined } : result;
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }
}
