import { Logger } from '@nestjs/common';
import { err, failure, ok, type Failure, type Result } from '../../shared/errors/index.js';
import { validMessage, type Mailer, type MailMessage } from './mailer.js';

export type CapturedMail = MailMessage & Readonly<{ sentAt: string }>;

const LIMIT = 500;

/**
 * Development mailer: keeps the latest messages in process for
 * `GET /dev/mail` instead of sending them. Messages carry secrets
 * (verification tokens), so production refuses this transport.
 */
export class CaptureMailer implements Mailer {
  private readonly logger = new Logger('CaptureMailer');
  private readonly messages: CapturedMail[] = [];

  send(message: MailMessage): Result<void, Failure> {
    if (!validMessage(message)) {
      return err(failure('invalid', 'mail message is invalid', { type: 'mail.invalid_message' }));
    }
    this.messages.push({ ...message, sentAt: new Date().toISOString() });
    if (this.messages.length > LIMIT) this.messages.shift();
    this.logger.log(`captured "${message.subject}"; read it at GET /dev/mail`);
    return ok(undefined);
  }

  /** Captured messages to `to`, newest first. */
  to(to: string): readonly CapturedMail[] {
    const address = to.trim().toLowerCase();
    return this.messages.filter((message) => message.to.toLowerCase() === address).reverse();
  }
}
