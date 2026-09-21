import { Module } from '@nestjs/common';
import { RequestContext } from './request-context.js';
import { RequestLoggerMiddleware } from './request-logger.middleware.js';

@Module({
  providers: [RequestContext, RequestLoggerMiddleware],
  exports: [RequestContext, RequestLoggerMiddleware],
})
export class PlatformHttpModule {}
