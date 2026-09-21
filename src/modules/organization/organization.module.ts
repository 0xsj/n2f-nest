import { Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
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

@Module({
  imports: [IdentityModule, PlatformEventsModule, PlatformHttpModule],
  controllers: [OrganizationController],
  providers: [OrganizationModuleStartup, OrganizationHttpWork, ...organizationProviders],
  exports: [GetOrganizationMembership],
})
export class OrganizationModule {}
