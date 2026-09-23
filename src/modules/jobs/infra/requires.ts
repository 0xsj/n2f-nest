/**
 * Capabilities Jobs requires from outside itself. The composition root
 * supplies a Nest module that provides and exports these tokens; Jobs never
 * names the module that fulfils them.
 */
export const JOBS_REQUIRES = Object.freeze({
  /** A `JobOrganizationAccessReader`: the caller's role in an organization. */
  organizationAccess: Symbol('jobs.requires.organizationAccess'),
});
