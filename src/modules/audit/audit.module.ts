import { Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { PlatformEventsModule } from '../../platform/events/events.module.js';
import { auditProviders } from './infra/audit.providers.js';
import { AuditEventSubscription } from './infra/in-memory/index.js';
import { AuditController } from './transport/http/index.js';

@Injectable()
class AuditModuleStartup implements OnModuleInit {
  private readonly logger = new Logger('AuditModule');

  onModuleInit(): void {
    this.logger.log('Audit module ready');
  }
}

@Module({
  imports: [PlatformEventsModule],
  controllers: [AuditController],
  providers: [
    AuditModuleStartup,
    AuditEventSubscription,
    ...auditProviders,
  ],
})
export class AuditModule {}
