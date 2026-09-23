import { Controller, Get, HttpException, HttpStatus, Inject, Query } from '@nestjs/common';
import { RUNTIME_CONFIG } from '../runtime/tokens.js';
import type { RuntimeConfig } from '../runtime/config.js';
import { CaptureMailer } from './capture-mailer.js';
import { MAILER, type Mailer } from './mailer.js';

function notFound(): HttpException {
  return new HttpException(
    {
      type: 'urn:n2f:problem:not_found',
      title: 'Not Found',
      detail: 'resource not found',
      kind: 'not_found',
      status: 404,
      code: 'http.not_found',
    },
    HttpStatus.NOT_FOUND,
  );
}

/**
 * The development mailbox: messages the capture mailer kept for one address,
 * newest first. It discloses verification tokens, so it answers only with
 * `N2F_DEV_ENDPOINTS` and the capture transport, which production refuses.
 */
@Controller('dev/mail')
export class DevMailController {
  constructor(
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  @Get()
  read(@Query('to') to?: string) {
    if (!this.config.http.devEndpoints || !(this.mailer instanceof CaptureMailer)) throw notFound();
    if (typeof to !== 'string' || to.length === 0 || to.length > 320) {
      throw new HttpException(
        {
          type: 'urn:n2f:problem:invalid',
          title: 'Bad Request',
          detail: 'query parameter to is required',
          kind: 'invalid',
          status: 400,
          code: 'http.invalid_query',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.mailer.to(to);
  }
}
