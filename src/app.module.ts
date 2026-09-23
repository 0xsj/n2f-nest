import {
  MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { AuditModule } from './modules/audit/api.js';
import { IdentityModule } from './modules/identity/api.js';
import { OrganizationModule } from './modules/organization/api.js';
import { auditOrganizationAccess, OrganizationIdentityBridge } from './integration/index.js';
import { PlatformHttpModule } from './platform/http/http.module.js';
import { RequestLoggerMiddleware } from './platform/http/request-logger.middleware.js';
import { SecurityHeadersMiddleware } from './platform/http/security-headers.middleware.js';
import { PlatformEventsModule } from './platform/events/events.module.js';
import { PlatformRuntimeModule } from './platform/runtime/runtime.module.js';
import { PlatformRateLimitModule } from './platform/ratelimit/index.js';
import { PlatformHealthModule } from './platform/health/index.js';
import { PlatformMetricsModule } from './platform/metrics/index.js';
import { PlatformMailModule } from './platform/mail/index.js';
import { appMigrations, legacyHistory } from './app/migrations.js';
// Example modules. A fork deletes every line marked `// example` (FORKING.md).
import { DocumentModule } from './modules/document/api.js'; // example
import { JobsModule } from './modules/jobs/api.js'; // example
import { documentOrganizationAccess, jobsOrganizationAccess } from './integration/index.js'; // example
import { DocumentProcessingModule } from './workflows/document-processing/index.js'; // example

/*
 * Module composition. Each module is registered once and receives the
 * capabilities it requires through bridges in integration/; no module names
 * another. The same registration objects are passed to every importer, so
 * Nest resolves each to a single instance.
 */
const organization = OrganizationModule.register({
  requires: [OrganizationIdentityBridge],
});
const document = DocumentModule.register({ requires: [documentOrganizationAccess(organization)] }); // example
const jobs = JobsModule.register({ requires: [jobsOrganizationAccess(organization)] }); // example

@Module({
  imports: [
    PlatformHttpModule,
    PlatformEventsModule,
    PlatformRuntimeModule.forRoot(appMigrations, legacyHistory),
    PlatformRateLimitModule,
    PlatformHealthModule,
    PlatformMetricsModule,
    PlatformMailModule,
    IdentityModule,
    organization,
    AuditModule.register({ requires: [auditOrganizationAccess(organization)] }),
    document, // example
    jobs, // example
    DocumentProcessingModule.register({ modules: [document, jobs, organization] }), // example
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SecurityHeadersMiddleware, RequestLoggerMiddleware).forRoutes('*');
  }
}
