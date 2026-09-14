/**
 * Identity-owned Argon2id password hashing behind bounded admission.
 * See CONTRACT.md (H01–H10). Uses the Node 24 built-in crypto.argon2.
 */
export { PasswordHasher } from './hasher.js';
export type { Outcome, Options } from './hasher.js';
export type { Limits } from './admission.js';
