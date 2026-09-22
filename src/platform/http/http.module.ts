import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { RequestContext } from './request-context.js';
import { RequestLoggerMiddleware } from './request-logger.middleware.js';
import { RequestProblemFilter } from './request-problem.filter.js';

@Module({
  providers: [
    RequestContext,
    RequestLoggerMiddleware,
    { provide: APP_FILTER, useClass: RequestProblemFilter },
  ],
  exports: [RequestContext, RequestLoggerMiddleware],
})
export class PlatformHttpModule {}
