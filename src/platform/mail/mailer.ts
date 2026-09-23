import type { Failure, Result } from '../../shared/errors/index.js';

export type MailMessage = Readonly<{
  to: string;
  subject: string;
  text: string;
}>;

/**
 * Outgoing mail. `send` accepts a message for delivery and returns at once:
 * delivery happens in the background, so a caller's response time does not
 * depend on the mail server, nor reveal which messages were sent. A refusal
 * means the message was not accepted (invalid, or the queue is full).
 */
export interface Mailer {
  send(message: MailMessage): Result<void, Failure>;
}

export const MAILER = Symbol('platform.mailer');

/** Rejects header injection and anything that is not a single plain address. */
export function validMessage(message: MailMessage): boolean {
  return (
    /^[^\s@<>,;"]+@[^\s@<>,;"]+$/.test(message.to) &&
    message.to.length <= 320 &&
    !/[\r\n]/.test(message.subject) &&
    message.subject.length <= 200 &&
    message.text.length <= 20_000
  );
}
