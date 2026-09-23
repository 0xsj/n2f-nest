import {
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type ModuleMetadata,
  type OnModuleInit,
} from '@nestjs/common';
import { PlatformEventsModule } from '../../platform/events/events.module.js';
import { auditProviders } from './infra/audit.providers.js';
import { AuditEventSubscription } from './infra/in-memory/index.js';
import { AuditController, OrganizationAuditController } from './transport/http/index.js';

@Injectable()
class AuditModuleStartup implements OnModuleInit {
  private readonly logger = new Logger('AuditModule');

  onModuleInit(): void {
    this.logger.log('Audit module ready');
  }
}

export type AuditModuleOptions = Readonly<{
  /**
   * Modules that provide and export every AUDIT_REQUIRES token. The
   * composition root chooses them; this module never names its providers.
   */
  requires: NonNullable<ModuleMetadata['imports']>;
}>;

@Module({})
export class AuditModule {
  static register(options: AuditModuleOptions): DynamicModule {
    return {
      module: AuditModule,
      imports: [PlatformEventsModule, ...options.requires],
      controllers: [AuditController, OrganizationAuditController],
      providers: [AuditModuleStartup, AuditEventSubscription, ...auditProviders],
    };
  }
}
