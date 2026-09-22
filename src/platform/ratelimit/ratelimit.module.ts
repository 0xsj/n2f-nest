import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { SystemClock } from '../../shared/clock/index.js';
import { RateLimiter, type RateLimitStore } from '../../shared/ratelimit/index.js';
import type { Database } from '../../shared/postgres/index.js';
import {
  DATABASE,
  requireDatabase,
  RUNTIME_CONFIG,
  type RuntimeConfig,
  usesPostgres,
} from '../runtime/index.js';
import { InMemoryRateLimitStore } from './in-memory-store.js';
import { RateLimitInterceptor } from './rate-limit.interceptor.js';
import { PostgresRateLimitStore } from './postgres/index.js';
import { RATE_LIMITER, RATE_LIMIT_STORE } from './tokens.js';

@Global()
@Module({
  providers: [
    SystemClock,
    InMemoryRateLimitStore,
    {
      provide: RATE_LIMIT_STORE,
      useFactory: (
        config: RuntimeConfig,
        database: Database | undefined,
        inMemory: InMemoryRateLimitStore,
      ): RateLimitStore =>
        usesPostgres(config)
          ? new PostgresRateLimitStore(requireDatabase(database, 'RateLimit'))
          : inMemory,
      inject: [RUNTIME_CONFIG, DATABASE, InMemoryRateLimitStore],
    },
    {
      provide: RATE_LIMITER,
      useFactory: (store: RateLimitStore, clock: SystemClock) =>
        new RateLimiter(store, clock),
      inject: [RATE_LIMIT_STORE, SystemClock],
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: RateLimitInterceptor,
    },
  ],
  exports: [RATE_LIMITER, RATE_LIMIT_STORE],
})
export class PlatformRateLimitModule {}
