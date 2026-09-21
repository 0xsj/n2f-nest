import { Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { PlatformEventsModule } from '../../platform/events/events.module.js';
import { PlatformHttpModule } from '../../platform/http/http.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { SubmitWorkflowJob } from './app/index.js';
import { jobsProviders } from './infra/jobs.providers.js';
import { JobsController, JobsHttpWork } from './transport/http/index.js';

@Injectable()
class JobsModuleStartup implements OnModuleInit {
  private readonly logger = new Logger('JobsModule');

  onModuleInit(): void {
    this.logger.log('Jobs module ready');
  }
}

@Module({
  imports: [OrganizationModule, PlatformEventsModule, PlatformHttpModule],
  controllers: [JobsController],
  providers: [JobsModuleStartup, JobsHttpWork, ...jobsProviders],
  exports: [SubmitWorkflowJob],
})
export class JobsModule {}
