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
import {
  BeginDocumentProcessing,
  CompleteDocumentProcessing,
  FailDocumentProcessing,
  RetryDocumentProcessing,
  CheckDocumentProcessable,
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

export type DocumentModuleOptions = Readonly<{
  /**
   * Modules that provide and export every DOCUMENT_REQUIRES token. The
   * composition root chooses them; this module never names its providers.
   */
  requires: NonNullable<ModuleMetadata['imports']>;
}>;

@Module({})
export class DocumentModule {
  static register(options: DocumentModuleOptions): DynamicModule {
    return {
      module: DocumentModule,
      imports: [PlatformEventsModule, PlatformHttpModule, ...options.requires],
      controllers: [DocumentController],
      providers: [DocumentModuleStartup, DocumentHttpWork, ...documentProviders],
      exports: [
        BeginDocumentProcessing,
        CompleteDocumentProcessing,
        FailDocumentProcessing,
        RetryDocumentProcessing,
        CheckDocumentProcessable,
      ],
    };
  }
}
