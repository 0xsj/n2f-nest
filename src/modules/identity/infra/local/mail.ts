import { inspect } from 'node:util';
import type { MailDelivery } from '../../app/command/index.js';

export interface UndeliveredMail extends MailDelivery {
  counts(): { verification: number; reset: number };
}
/**
 * UndeliveredMailAdapter: reports not delivered without any external effect and
 * retains neither address nor token (M01). Root uses it only without SMTP
 * configuration and says so in its manifest; stage 7 replaces it.
 */
class UndeliveredMailAdapter implements UndeliveredMail {
  #verification = 0;
  #reset = 0;
  async sendVerification(): Promise<boolean> {
    this.#verification++;
    return false;
  }
  async sendReset(): Promise<boolean> {
    this.#reset++;
    return false;
  }
  counts(): { verification: number; reset: number } {
    return { verification: this.#verification, reset: this.#reset };
  }
  toJSON(): { delivery: 'disabled' } {
    return { delivery: 'disabled' };
  }
  [inspect.custom](): string {
    return 'UndeliveredMailAdapter';
  }
}
export const undeliveredMail = (): UndeliveredMail =>
  new UndeliveredMailAdapter();
