import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { err, failure, ok, type Failure, type Result } from '../../shared/errors/index.js';
import type { SecretString } from '../../shared/secret/index.js';
import { validMessage, type Mailer, type MailMessage } from './mailer.js';

const QUEUE_LIMIT = 1000;
const ATTEMPTS = 4;
const BASE_DELAY_MS = 2000;

/** The recipient's domain only: addresses are personal data and stay out of logs. */
function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1);
}

/**
 * SMTP delivery through a bounded in-process queue. A message is retried with
 * backoff and then dropped with an error log; mail is best effort, and the
 * flows that send it offer a resend. Messages still queued at shutdown are
 * given `drainMs` to go out.
 */
export class SmtpMailer implements Mailer, OnModuleDestroy {
  private readonly logger = new Logger('SmtpMailer');
  private readonly transport: Transporter;
  private readonly queue: MailMessage[] = [];
  private running?: Promise<void>;
  private stopping = false;

  constructor(
    url: SecretString,
    private readonly from: string,
    private readonly drainMs = 5000,
  ) {
    this.transport = createTransport(url.reveal());
  }

  send(message: MailMessage): Result<void, Failure> {
    if (!validMessage(message)) {
      return err(failure('invalid', 'mail message is invalid', { type: 'mail.invalid_message' }));
    }
    if (this.stopping || this.queue.length >= QUEUE_LIMIT) {
      return err(failure('unavailable', 'mail queue is unavailable', { type: 'mail.queue_full' }));
    }
    this.queue.push(message);
    this.running ??= this.drain().finally(() => {
      this.running = undefined;
    });
    return ok(undefined);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.running) {
      await Promise.race([this.running, new Promise((resolve) => setTimeout(resolve, this.drainMs).unref())]);
    }
    if (this.queue.length > 0) this.logger.error(`dropped ${this.queue.length} unsent message(s) at shutdown`);
    this.transport.close();
  }

  private async drain(): Promise<void> {
    for (let message = this.queue.shift(); message; message = this.queue.shift()) {
      await this.deliver(message);
    }
  }

  private async deliver(message: MailMessage): Promise<void> {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        await this.transport.sendMail({ from: this.from, to: message.to, subject: message.subject, text: message.text });
        return;
      } catch (cause) {
        const code = (cause as { code?: string }).code ?? 'unknown';
        if (attempt === ATTEMPTS || this.stopping) {
          this.logger.error(`gave up on mail to @${domainOf(message.to)} after ${attempt} attempt(s): ${code}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS * 2 ** (attempt - 1)).unref());
      }
    }
  }
}
