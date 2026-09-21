import { Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { PlatformEventsModule } from '../../platform/events/events.module.js';
import { PlatformHttpModule } from '../../platform/http/http.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import {
  BeginDocumentProcessing,
  CompleteDocumentProcessing,
  FailDocumentProcessing,
} from './app/index.js';
import { documentProviders } from './infra/document.providers.js';
import { DocumentController, DocumentHttpWork } from './transport/http/index.js';

@Injectable()
class DocumentModuleStartup implements OnModuleInit {
  private readonly logger = new Logger('DocumentModule');

  onModuleInit(): void {
    this.logger.log('Document module ready');
  }
}

@Module({
  imports: [OrganizationModule, PlatformEventsModule, PlatformHttpModule],
  controllers: [DocumentController],
  providers: [DocumentModuleStartup, DocumentHttpWork, ...documentProviders],
  exports: [
    BeginDocumentProcessing,
    CompleteDocumentProcessing,
    FailDocumentProcessing,
  ],
})
export class DocumentModule {}
