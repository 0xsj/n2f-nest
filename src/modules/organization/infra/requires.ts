/**
 * Capabilities Organization requires from outside itself. The composition
 * root supplies a Nest module that provides and exports these tokens;
 * Organization never names the module that fulfils them.
 */
export const ORGANIZATION_REQUIRES = Object.freeze({
  /** A `CurrentActorReader`: resolves a session token to the acting identity. */
  currentActor: Symbol('organization.requires.currentActor'),
  /** An `IdentityReferenceReader`: confirms an identity exists and is active. */
  identityReferences: Symbol('organization.requires.identityReferences'),
});
