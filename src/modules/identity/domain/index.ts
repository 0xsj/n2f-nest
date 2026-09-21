export { IDENTITY_EVENT_TYPES, type IdentityEventType } from './events.js';

export {
  IDENTITY_STATUSES,
  Identity,
  type IdentityFailure,
  type IdentityFailureType,
  type IdentityStatus,
  type RegisterIdentityInput,
} from './identity.js';

export {
  CREDENTIAL_METHODS,
  CREDENTIAL_STATUSES,
  Credential,
  normalizeEmail,
  type CreateEmailPasswordCredentialInput,
  type CredentialMethod,
  type CredentialFailure,
  type CredentialFailureType,
  type CredentialStatus,
  type EmailAddress,
} from './credential.js';

export {
  VERIFICATION_PURPOSES,
  VERIFICATION_STATUSES,
  VerificationChallenge,
  type IssueVerificationChallengeInput,
  type VerificationFailure,
  type VerificationFailureType,
  type VerificationPurpose,
  type VerificationStatus,
} from './verification-challenge.js';

export {
  SESSION_STATUSES,
  Session,
  type CreateSessionInput,
  type SessionFailure,
  type SessionInvalidFailureType,
  type SessionStatus,
} from './session.js';
