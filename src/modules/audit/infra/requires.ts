/**
 * Capabilities Audit requires from outside itself. The composition root
 * supplies a Nest module that provides and exports these tokens; Audit never
 * names the module that fulfils them.
 */
export const AUDIT_REQUIRES = Object.freeze({
  /** An `AuditOrganizationAccessReader`: the caller's role in an organization. */
  organizationAccess: Symbol('audit.requires.organizationAccess'),
});
