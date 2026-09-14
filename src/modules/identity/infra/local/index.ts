/**
 * Identity local adapters (CONTRACT.md): a process-local attempt limiter, a
 * file-backed password blocklist and an undelivered mail adapter. They let root
 * run the authentication process before stage 7; none is production protection.
 * @module modules/identity/infra/local
 */
export {
  createLimiter,
  DEFAULT_LIMITS,
  type LimiterConfig,
  type LocalLimiter,
  type OperationLimits,
  type Window,
} from './limiter.js';
export { loadBlocklist, type Blocklist } from './blocklist.js';
export { undeliveredMail, type UndeliveredMail } from './mail.js';
