/**
 * Capabilities Document requires from outside itself. The composition root
 * supplies a Nest module that provides and exports these tokens; Document
 * never names the module that fulfils them.
 */
export const DOCUMENT_REQUIRES = Object.freeze({
  /** An `OrganizationAccessReader`: the caller's role in an organization. */
  organizationAccess: Symbol('document.requires.organizationAccess'),
});
