import { Injectable, Module, type DynamicModule } from '@nestjs/common';
import type { Failure, Result } from '../shared/errors/index.js';
import type { ID } from '../shared/id/index.js';
import type { SecretString } from '../shared/secret/index.js';
import { GetOrganizationMembership } from '../modules/organization/api.js';
import { AUDIT_REQUIRES, type AuditOrganizationAccessReader } from '../modules/audit/api.js';

/** What the bridge answers: the caller's identity and role in the organization. */
export type OrganizationAccessView = Readonly<{
  organizationId: ID;
  identityId: ID;
  role: 'owner' | 'admin' | 'member';
}>;

/**
 * A caller's access to an organization, answered by Organization's membership
 * query. Only an active membership in an active organization grants access.
 * Each consumer module declares this port in its own terms; the shapes
 * coincide, so one bridge serves them all. Each consumer's provider lives in
 * its own file, so deleting a module deletes its wiring.
 */
@Injectable()
export class OrganizationAccessBridge {
  constructor(private readonly membership: GetOrganizationMembership) {}

  async find(
    sessionToken: SecretString,
    organizationId: ID,
    signal?: AbortSignal,
  ): Promise<Result<OrganizationAccessView | null, Failure>> {
    const result = await this.membership.execute({ sessionToken, organizationId, signal });
    if (!result.ok) return result;
    const view = result.value;
    if (
      view === null ||
      view.organization.status !== 'active' ||
      view.membership.status !== 'active'
    ) {
      return { ok: true, value: null };
    }
    return {
      ok: true,
      value: {
        organizationId: view.organization.id,
        identityId: view.membership.identityId,
        role: view.membership.role,
      },
    };
  }
}

@Module({})
export class OrganizationAccessBridgeModule {
  /**
   * Supplies one consumer's organization-access token from `organization`,
   * the composition root's single OrganizationModule registration. `Port` is
   * the consumer's port type; the trailing parameter makes the call fail to
   * compile when the bridge no longer satisfies it.
   */
  static provide<Port>(
    token: symbol,
    organization: DynamicModule,
    ..._bridgeSatisfiesPort: OrganizationAccessBridge extends Port ? [] : [never]
  ): DynamicModule {
    return {
      module: OrganizationAccessBridgeModule,
      imports: [organization],
      providers: [OrganizationAccessBridge, { provide: token, useExisting: OrganizationAccessBridge }],
      exports: [token],
    };
  }
}

export const auditOrganizationAccess = (organization: DynamicModule): DynamicModule =>
  OrganizationAccessBridgeModule.provide<AuditOrganizationAccessReader>(
    AUDIT_REQUIRES.organizationAccess,
    organization,
  );
