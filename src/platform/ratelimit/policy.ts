import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { RateLimitRule } from '../../shared/ratelimit/index.js';

export type HttpRateLimitPolicy = Readonly<RateLimitRule & {
  name: string;
  key: (request: Request) => string;
}>;

export const RATE_LIMIT_POLICY = Symbol('platform.rateLimit.policy');

/**
 * Attach reusable transport policies without coupling them to an identity
 * domain. Every policy must allow the request; they are consumed in order.
 */
export function RateLimit(
  ...policies: [HttpRateLimitPolicy, ...HttpRateLimitPolicy[]]
): MethodDecorator & ClassDecorator {
  return SetMetadata(RATE_LIMIT_POLICY, Object.freeze(policies));
}

/** The client a request comes from, as resolved under the configured proxy trust. */
export function clientOf(request: Request): string {
  return request.ip || request.socket.remoteAddress || 'unknown';
}

/** A policy keyed by client address alone. */
export function perClient(name: string, limit: number, windowMs: number): HttpRateLimitPolicy {
  return Object.freeze({ name, limit, windowMs, key: clientOf });
}
