/**
 * Identity application commands (CONTRACT.md U04–U07, U09–U14). Each command is
 * created with the narrow ports it consumes and validated configuration; ports
 * return values for expected outcomes and pass dependency failures through.
 * @module modules/identity/app/command
 */
export {
  ChangePassword,
  type ChangePasswordInput,
  type ChangePasswordPorts,
  type ChangePasswordResult,
} from './change-password.js';
export { DEFAULT_CONFIG, validateConfig, type Config } from './config.js';
export {
  Login,
  type LoginInput,
  type LoginPorts,
  type LoginResult,
} from './login.js';
export {
  Logout,
  LogoutAll,
  type AuthenticatedInput,
  type LogoutAllPorts,
  type LogoutAllResult,
  type LogoutPorts,
  type LogoutResult,
} from './logout.js';
export type {
  Admission,
  AttemptLimiter,
  ChallengeReader,
  ChallengeRecord,
  ChallengeStore,
  ChangePasswordRecord,
  Clock,
  CredentialReader,
  CredentialRecord,
  EnrollmentPolicy,
  EpochStore,
  IDSource,
  IssueChallengeRecord,
  IssuedToken,
  LoginRecord,
  LoginStore,
  MailDelivery,
  PasswordHasherPort,
  PasswordStore,
  Ports,
  RegisterRecord,
  RegisterStore,
  ResetPasswordRecord,
  SessionRevoker,
  Store,
  TokenCodecPort,
  VerifyRecord,
  VerifyStore,
  UpgradeTicketAdmission,
  UpgradeTicketRecord,
  UpgradeTicketStore,
} from './ports.js';
export {
  Register,
  displayNameFrom,
  type RegisterInput,
  type RegisterPorts,
  type RegisterResult,
} from './register.js';
export {
  RequestReset,
  RequestVerification,
  type RequestChallengeInput,
  type RequestChallengePorts,
  type RequestChallengeResult,
} from './request-challenge.js';
export {
  ResetPassword,
  type ResetPasswordInput,
  type ResetPasswordPorts,
  type ResetPasswordResult,
} from './reset-password.js';
export {
  VerifyEmail,
  type VerifyEmailInput,
  type VerifyEmailPorts,
  type VerifyEmailResult,
} from './verify-email.js';
export {
  WebSocketTicket,
  type WebSocketTicketInput,
  type WebSocketTicketPorts,
  type WebSocketTicketResult,
} from './websocket-ticket.js';
