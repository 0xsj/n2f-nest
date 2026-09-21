import { Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { PlatformEventsModule } from '../../platform/events/events.module.js';
import { PlatformHttpModule } from '../../platform/http/http.module.js';
import { SystemClock } from '../../shared/clock/index.js';
import { V7 } from '../../shared/id/index.js';
import { Factory as ProvenanceFactory } from '../../shared/provenance/index.js';
import { DocumentModule } from '../../modules/document/document.module.js';
import {
  BeginDocumentProcessing,
} from '../../modules/document/app/index.js';
import { JobsModule } from '../../modules/jobs/jobs.module.js';
import { SubmitWorkflowJob } from '../../modules/jobs/app/index.js';
import { OrganizationModule } from '../../modules/organization/organization.module.js';
import { GetOrganizationMembership } from '../../modules/organization/app/index.js';
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

@Module({
  imports: [
    DocumentModule,
    JobsModule,
    OrganizationModule,
    PlatformEventsModule,
    PlatformHttpModule,
  ],
  controllers: [DocumentProcessingController],
  providers: [
    DocumentProcessingModuleStartup,
    DocumentProcessingJobEventSubscription,
    DocumentProcessingHttpWork,
    {
      provide: RequestDocumentProcessing,
      useFactory: (
        membership: GetOrganizationMembership,
        factory: ProvenanceFactory,
        begin: BeginDocumentProcessing,
        submit: SubmitWorkflowJob,
      ) => new RequestDocumentProcessing({ membership, factory, begin, submit }),
      inject: [
        GetOrganizationMembership,
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
})
export class DocumentProcessingModule {}
