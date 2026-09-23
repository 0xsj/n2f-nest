import type { DynamicModule } from '@nestjs/common';
import { DOCUMENT_REQUIRES, type OrganizationAccessReader } from '../modules/document/api.js';
import { OrganizationAccessBridgeModule } from './organization-access.js';

/** Document's organization access, answered by Organization. */
export const documentOrganizationAccess = (organization: DynamicModule): DynamicModule =>
  OrganizationAccessBridgeModule.provide<OrganizationAccessReader>(
    DOCUMENT_REQUIRES.organizationAccess,
    organization,
  );
