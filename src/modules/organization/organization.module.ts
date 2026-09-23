import {
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type ModuleMetadata,
  type OnModuleInit,
} from '@nestjs/common';
import { PlatformEventsModule } from '../../platform/events/events.module.js';
import { PlatformHttpModule } from '../../platform/http/http.module.js';
import { organizationProviders } from './infra/organization.providers.js';
import { GetOrganizationMembership } from './app/index.js';
import { OrganizationController, OrganizationHttpWork } from './transport/http/index.js';

@Injectable()
class OrganizationModuleStartup implements OnModuleInit {
  private readonly logger = new Logger('OrganizationModule');

  onModuleInit(): void {
    this.logger.log('Organization module ready');
  }
}

export type OrganizationModuleOptions = Readonly<{
  /**
   * Modules that provide and export every ORGANIZATION_REQUIRES token. The
   * composition root chooses them; this module never names its providers.
   */
  requires: NonNullable<ModuleMetadata['imports']>;
}>;

@Module({})
export class OrganizationModule {
  static register(options: OrganizationModuleOptions): DynamicModule {
    return {
      module: OrganizationModule,
      imports: [PlatformEventsModule, PlatformHttpModule, ...options.requires],
      controllers: [OrganizationController],
      providers: [OrganizationModuleStartup, OrganizationHttpWork, ...organizationProviders],
      exports: [GetOrganizationMembership],
    };
  }
}
