import type { DynamicModule } from '@nestjs/common';
import { JOBS_REQUIRES, type JobOrganizationAccessReader } from '../modules/jobs/api.js';
import { OrganizationAccessBridgeModule } from './organization-access.js';

/** Jobs' organization access, answered by Organization. */
export const jobsOrganizationAccess = (organization: DynamicModule): DynamicModule =>
  OrganizationAccessBridgeModule.provide<JobOrganizationAccessReader>(
    JOBS_REQUIRES.organizationAccess,
    organization,
  );
