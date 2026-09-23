import {
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type OnModuleInit,
} from '@nestjs/common';
import { PlatformEventsModule } from '../../platform/events/events.module.js';
import { PlatformHttpModule } from '../../platform/http/http.module.js';
import { SystemClock } from '../../shared/clock/index.js';
import { V7 } from '../../shared/id/index.js';
import { Factory as ProvenanceFactory } from '../../shared/provenance/index.js';
import { BeginDocumentProcessing } from '../../modules/document/commands.js';
import { SubmitWorkflowJob } from '../../modules/jobs/commands.js';
import { GetOrganizationMembership } from '../../modules/organization/api.js';
import { CheckDocumentProcessable } from '../../modules/document/api.js';
import { RequestDocumentProcessing } from './app/request-document-processing.js';
import { DocumentProcessingJobEventSubscription } from './infra/job-event-subscription.js';
import { DocumentProcessingController } from './transport/http/controller.js';
import { DocumentProcessingHttpWork } from './transport/http/work.js';

@Injectable()
class DocumentProcessingModuleStartup implements OnModuleInit {
  private readonly logger = new Logger('DocumentProcessingWorkflow');

  onModuleInit(): void {
    this.logger.log('Document processing workflow ready');
  }
}

export type DocumentProcessingModuleOptions = Readonly<{
  /**
   * The composition root's registrations of the modules this workflow
   * coordinates: Document, Jobs and Organization.
   */
  modules: readonly DynamicModule[];
}>;

@Module({})
export class DocumentProcessingModule {
  static register(options: DocumentProcessingModuleOptions): DynamicModule {
    return {
      module: DocumentProcessingModule,
      imports: [...options.modules, PlatformEventsModule, PlatformHttpModule],
      controllers: [DocumentProcessingController],
      providers: [
        DocumentProcessingModuleStartup,
        DocumentProcessingJobEventSubscription,
        DocumentProcessingHttpWork,
        {
          provide: RequestDocumentProcessing,
          useFactory: (
            membership: GetOrganizationMembership,
            processable: CheckDocumentProcessable,
            factory: ProvenanceFactory,
            begin: BeginDocumentProcessing,
            submit: SubmitWorkflowJob,
          ) => new RequestDocumentProcessing({ membership, processable, factory, begin, submit }),
          inject: [
            GetOrganizationMembership,
            CheckDocumentProcessable,
            ProvenanceFactory,
            BeginDocumentProcessing,
            SubmitWorkflowJob,
          ],
        },
        SystemClock,
        {
          provide: V7,
          useFactory: (clock: SystemClock) => new V7(clock),
          inject: [SystemClock],
        },
        {
          provide: ProvenanceFactory,
          useFactory: (clock: SystemClock, ids: V7) => new ProvenanceFactory(clock, ids),
          inject: [SystemClock, V7],
        },
      ],
    };
  }
}
