import {
  MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { AuditModule } from './modules/audit/audit.module.js';
import { DocumentModule } from './modules/document/document.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { JobsModule } from './modules/jobs/jobs.module.js';
import { OrganizationModule } from './modules/organization/organization.module.js';
import { PlatformHttpModule } from './platform/http/http.module.js';
import { RequestLoggerMiddleware } from './platform/http/request-logger.middleware.js';
import { PlatformEventsModule } from './platform/events/events.module.js';
import { PlatformRuntimeModule } from './platform/runtime/runtime.module.js';
import { PlatformRateLimitModule } from './platform/ratelimit/index.js';
import { PlatformHealthModule } from './platform/health/index.js';
import { PlatformMetricsModule } from './platform/metrics/index.js';
import { appMigrations } from './app/migrations.js';
import { DocumentProcessingModule } from './workflows/document-processing/index.js';

@Module({
  imports: [
    PlatformHttpModule,
    PlatformEventsModule,
    PlatformRuntimeModule.forRoot(appMigrations),
    PlatformRateLimitModule,
    PlatformHealthModule,
    PlatformMetricsModule,
    IdentityModule,
    OrganizationModule,
    DocumentModule,
    JobsModule,
    AuditModule,
    DocumentProcessingModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLoggerMiddleware).forRoutes('*');
  }
}
