import { Global, Module } from '@nestjs/common';
import { RUNTIME_CONFIG } from '../runtime/tokens.js';
import type { RuntimeConfig } from '../runtime/config.js';
import { CaptureMailer } from './capture-mailer.js';
import { DevMailController } from './mail.controller.js';
import { MAILER, type Mailer } from './mailer.js';
import { SmtpMailer } from './smtp-mailer.js';

@Global()
@Module({
  controllers: [DevMailController],
  providers: [
    {
      provide: MAILER,
      useFactory: (config: RuntimeConfig): Mailer =>
        config.mail.transport === 'smtp' && config.mail.smtpUrl
          ? new SmtpMailer(config.mail.smtpUrl, config.mail.from)
          : new CaptureMailer(),
      inject: [RUNTIME_CONFIG],
    },
  ],
  exports: [MAILER],
})
export class PlatformMailModule {}
