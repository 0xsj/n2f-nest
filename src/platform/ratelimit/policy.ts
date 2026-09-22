import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { RateLimitRule } from '../../shared/ratelimit/index.js';

export type HttpRateLimitPolicy = Readonly<RateLimitRule & {
  name: string;
  key: (request: Request) => string;
}>;

export const RATE_LIMIT_POLICY = Symbol('platform.rateLimit.policy');

/** Attach a reusable transport policy without coupling it to an identity domain. */
export function RateLimit(policy: HttpRateLimitPolicy): MethodDecorator & ClassDecorator {
  return SetMetadata(RATE_LIMIT_POLICY, policy);
}
