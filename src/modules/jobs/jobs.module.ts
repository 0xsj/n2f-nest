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

export type JobsModuleOptions = Readonly<{
  /**
   * Modules that provide and export every JOBS_REQUIRES token. The
   * composition root chooses them; this module never names its providers.
   */
  requires: NonNullable<ModuleMetadata['imports']>;
}>;

@Module({})
export class JobsModule {
  static register(options: JobsModuleOptions): DynamicModule {
    return {
      module: JobsModule,
      imports: [PlatformEventsModule, PlatformHttpModule, ...options.requires],
      controllers: [JobsController],
      providers: [JobsModuleStartup, JobsHttpWork, ...jobsProviders],
      exports: [SubmitWorkflowJob],
    };
  }
}
