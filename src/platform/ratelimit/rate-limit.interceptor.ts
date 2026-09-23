import {
  Inject,
  Injectable,
  HttpException,
  HttpStatus,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { from, mergeMap, type Observable } from 'rxjs';
import { problemOf } from '../../shared/http/index.js';
import { failure, type Failure, type Result } from '../../shared/errors/index.js';
import { RateLimiter, type RateLimitDecision } from '../../shared/ratelimit/index.js';
import { RATE_LIMITER } from './tokens.js';
import {
  RATE_LIMIT_POLICY,
  type HttpRateLimitPolicy,
} from './policy.js';

function failureResponse(error: Failure): HttpException {
  const result: Result<never, Failure> = { ok: false, error };
  const problem = problemOf(result);
  return new HttpException(
    problem ?? { status: HttpStatus.SERVICE_UNAVAILABLE, ...error },
    problem?.status ?? HttpStatus.SERVICE_UNAVAILABLE,
  );
}

function writeHeaders(response: Response, decision: RateLimitDecision): void {
  response.setHeader('X-RateLimit-Limit', String(decision.limit));
  response.setHeader('X-RateLimit-Remaining', String(decision.remaining));
  response.setHeader(
    'X-RateLimit-Reset',
    String(Math.ceil(decision.resetAt.getTime() / 1000)),
  );
  if (!decision.allowed) {
    response.setHeader(
      'Retry-After',
      String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))),
    );
  }
}

@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const policies = this.reflector.getAllAndOverride<
      readonly HttpRateLimitPolicy[]
    >(RATE_LIMIT_POLICY, [context.getHandler(), context.getClass()]);
    if (!policies?.length) return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    return from(this.#consume(policies, request)).pipe(
      mergeMap((outcome) => {
        if (!outcome.ok) throw failureResponse(outcome.error);

        writeHeaders(response, outcome.value.decision);
        if (!outcome.value.decision.allowed) {
          throw failureResponse(
            failure('rate_limited', 'request rate limit exceeded', {
              type: 'rate_limit.exceeded',
              fields: { policy: outcome.value.policy },
            }),
          );
        }

        return next.handle();
      }),
    );
  }

  /**
   * Consume each policy until one refuses. The reported decision is the
   * refusal, or otherwise the policy with the fewest requests remaining.
   */
  async #consume(
    policies: readonly HttpRateLimitPolicy[],
    request: Request,
  ): Promise<Result<{ policy: string; decision: RateLimitDecision }, Failure>> {
    let tightest: { policy: string; decision: RateLimitDecision } | undefined;
    for (const policy of policies) {
      const result = await this.limiter.consume(
        `${policy.name}:${policy.key(request)}`,
        policy,
      );
      if (!result.ok) return result;
      const current = { policy: policy.name, decision: result.value };
      if (!result.value.allowed) return { ok: true, value: current };
      if (!tightest || result.value.remaining < tightest.decision.remaining) {
        tightest = current;
      }
    }
    return { ok: true, value: tightest! };
  }
}
