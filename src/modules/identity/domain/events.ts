/** Event names owned by the Identity bounded context. */
export const IDENTITY_EVENT_TYPES = Object.freeze({
  registered: 'identity.registered.v1',
  sessionCreated: 'identity.session.created.v1',
  sessionRevoked: 'identity.session.revoked.v1',
  verificationChallengeIssued: 'identity.verification.challenge.issued.v1',
  verified: 'identity.verified.v1',
} as const);

export type IdentityEventType =
  (typeof IDENTITY_EVENT_TYPES)[keyof typeof IDENTITY_EVENT_TYPES];
