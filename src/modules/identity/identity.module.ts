import { Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { PlatformEventsModule } from '../../platform/events/events.module.js';
import { PlatformHttpModule } from '../../platform/http/http.module.js';
import { GetCurrentIdentity, GetIdentity } from './app/index.js';
import { identityProviders } from './infra/identity.providers.js';
import { IdentityController, IdentityHttpWork } from './transport/http/index.js';

@Injectable()
class IdentityModuleStartup implements OnModuleInit {
  private readonly logger = new Logger('IdentityModule');

  onModuleInit(): void {
    this.logger.log('Identity module ready');
  }
}

@Module({
  imports: [PlatformHttpModule, PlatformEventsModule],
  controllers: [IdentityController],
  providers: [
    IdentityModuleStartup,
    IdentityHttpWork,
    ...identityProviders,
  ],
  exports: [GetCurrentIdentity, GetIdentity],
})
export class IdentityModule {}
