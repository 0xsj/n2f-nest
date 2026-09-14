import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { Envelope } from '../../../../shared/events/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type { ChallengeSnapshot } from '../../domain/challenge.js';
import type { CredentialSnapshot } from '../../domain/credential.js';
import type { Email } from '../../domain/email.js';
import type { NewPassword, PasswordInput } from '../../domain/password.js';
import type {
  Snapshot as PrincipalSnapshot,
  Status,
} from '../../domain/principal.js';
import type { SessionSnapshot } from '../../domain/session.js';
import type { TokenDigest, TokenPurpose } from '../../domain/token.js';
import type { UpgradeTicketSnapshot } from '../../domain/upgrade-ticket.js';

/**
 * Ports declared by the identity commands (CONTRACT.md). Values express expected
 * outcomes; a Failure means a dependency problem and passes through unchanged.
 * No HTTP, database or crypto SDK type appears here.
 */
export interface Clock {
  now(): Date;
}
export interface IDSource {
  newId(): Result<ID, Failure>;
}
export interface PasswordHasherPort {
  hash(password: NewPassword): Promise<Result<SecretString, Failure>>;
  /** True when the input matches the record; false is a value, never a failure. */
  verify(
    input: PasswordInput,
    record: SecretString,
  ): Promise<Result<boolean, Failure>>;
  /** Comparable work for an unknown login identifier; always resolves false. */
  verifyAbsent(input: PasswordInput): Promise<Result<boolean, Failure>>;
}
export type IssuedToken = Readonly<{
  secret: SecretString;
  digest: TokenDigest;
}>;
export interface TokenCodecPort {
  issue(purpose: TokenPurpose): Result<IssuedToken, Failure>;
  digest(
    purpose: TokenPurpose,
    secret: SecretString,
  ): Result<TokenDigest, Failure>;
}
export interface EnrollmentPolicy {
  /** True when the password is allowed; false is a blocklist refusal. */
  checkBlocklist(password: NewPassword): Promise<Result<boolean, Failure>>;
}
export type Admission =
  | Readonly<{ permitted: true }>
  | Readonly<{ permitted: false; retryAfterMs: number }>;
export interface AttemptLimiter {
  /** The subject is private (canonical email or an ID); the adapter digests it. */
  admit(
    operation: string,
    subject: SecretString,
    source: string,
  ): Promise<Result<Admission, Failure>>;
}
export interface MailDelivery {
  /** Resolves whether the message reached SMTP; a rejection is treated as not delivered. */
  sendVerification(
    to: Email,
    token: SecretString,
    expiresAtMs: number,
  ): Promise<boolean>;
  sendReset(
    to: Email,
    token: SecretString,
    expiresAtMs: number,
  ): Promise<boolean>;
}

export type CredentialRecord = Readonly<{
  principal: PrincipalSnapshot;
  credential: CredentialSnapshot;
  authEpoch: number;
}>;
export type ChallengeRecord = Readonly<{
  challenge: ChallengeSnapshot;
  credential: CredentialSnapshot;
  principalStatus: Status;
  authEpoch: number;
}>;
export type RegisterRecord = Readonly<{
  principal: PrincipalSnapshot;
  authEpoch: number;
  credential: CredentialSnapshot;
  challenge: ChallengeSnapshot;
  events: readonly Envelope[];
}>;
export type LoginRecord = Readonly<{
  session: SessionSnapshot;
  expectedPasswordVersion: number;
  expectedAuthEpoch: number;
  events: readonly Envelope[];
}>;
export type IssueChallengeRecord = Readonly<{
  challenge: ChallengeSnapshot;
  expectedPasswordVersion: number;
}>;
export type VerifyRecord = Readonly<{
  challengeId: ID;
  principalId: ID;
  consumedAtMs: number;
  expectedPasswordVersion: number;
  events: readonly Envelope[];
}>;
export type ChangePasswordRecord = Readonly<{
  principalId: ID;
  passwordHash: SecretString;
  expectedPasswordVersion: number;
  expectedAuthEpoch: number;
  changedAtMs: number;
  events: readonly Envelope[];
}>;
export type ResetPasswordRecord = Readonly<{
  challengeId: ID;
  principalId: ID;
  passwordHash: SecretString;
  consumedAtMs: number;
  changedAtMs: number;
  expectedPasswordVersion: number;
  expectedAuthEpoch: number;
  setVerified: boolean;
  events: readonly Envelope[];
}>;
export type UpgradeTicketRecord = Readonly<{
  ticket: UpgradeTicketSnapshot;
  expectedAuthEpoch: number;
}>;
export type UpgradeTicketAdmission = Readonly<{
  principalId: ID;
  sessionId: ID;
  authEpoch: number;
}>;
export interface UpgradeTicketStore {
  issueUpgradeTicket(record: UpgradeTicketRecord): Promise<Result<'committed' | 'stale', Failure>>;
  consumeUpgradeTicket(digest: TokenDigest, nowMs: number): Promise<Result<UpgradeTicketAdmission | undefined, Failure>>;
}

/** Each store operation is one transaction promised by AUTH_SCHEMA.md (stage 5). */
export interface RegisterStore {
  register(
    record: RegisterRecord,
  ): Promise<Result<'created' | 'duplicate_email', Failure>>;
}
export interface CredentialReader {
  findByEmail(
    email: Email,
  ): Promise<Result<CredentialRecord | undefined, Failure>>;
  findByPrincipal(
    principalId: ID,
  ): Promise<Result<CredentialRecord | undefined, Failure>>;
}
export interface LoginStore {
  commitLogin(
    record: LoginRecord,
  ): Promise<Result<'committed' | 'stale', Failure>>;
}
export interface SessionRevoker {
  revokeSession(
    sessionId: ID,
    principalId: ID,
    nowMs: number,
    event: Envelope,
  ): Promise<Result<'revoked' | 'already_inactive' | 'absent', Failure>>;
}
export interface EpochStore {
  revokeAll(
    principalId: ID,
    expectedEpoch: number,
    nowMs: number,
    event: Envelope,
  ): Promise<Result<'committed' | 'stale', Failure>>;
}
export interface ChallengeReader {
  findByDigest(
    purpose: TokenPurpose,
    digest: TokenDigest,
  ): Promise<Result<ChallengeRecord | undefined, Failure>>;
}
export interface ChallengeStore {
  issueChallenge(
    record: IssueChallengeRecord,
  ): Promise<Result<'issued' | 'stale', Failure>>;
}
export interface VerifyStore {
  verifyEmail(
    record: VerifyRecord,
  ): Promise<Result<'committed' | 'stale', Failure>>;
}
export interface PasswordStore {
  changePassword(
    record: ChangePasswordRecord,
  ): Promise<Result<'committed' | 'stale', Failure>>;
  resetPassword(
    record: ResetPasswordRecord,
  ): Promise<Result<'committed' | 'stale', Failure>>;
}
export type Store = RegisterStore &
  CredentialReader &
  LoginStore &
  SessionRevoker &
  EpochStore &
  ChallengeReader &
  ChallengeStore &
  VerifyStore &
  PasswordStore &
  UpgradeTicketStore;

/** The full set a composition root supplies; each command narrows it. */
export type Ports = Readonly<{
  clock: Clock;
  ids: IDSource;
  hasher: PasswordHasherPort;
  codec: TokenCodecPort;
  policy: EnrollmentPolicy;
  limiter: AttemptLimiter;
  mail: MailDelivery;
  store: Store;
}>;
