import {
  err,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { assertEventWork } from '../../../../shared/events/index.js';
import { enqueue } from '../../../../shared/events/postgres/index.js';
import type { Envelope } from '../../../../shared/events/index.js';
import { map, type TransactionDatabase } from '../../../../shared/postgres/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { OrganizationWriter } from '../../app/ports/index.js';
import type { Membership, Organization } from '../../domain/index.js';

/** Persists the organization aggregate pair and both facts in one transaction. */
export class PostgresOrganizationWriter implements OrganizationWriter {
  constructor(private readonly database: TransactionDatabase) {}

  commit(input: {
    organization: Organization;
    ownerMembership: Membership;
    events: readonly Envelope[];
    work: WorkContext;
    signal?: AbortSignal;
  }): Promise<Result<void, Failure>> {
    return this.database.transaction<void>(async (transaction) => {
      for (const event of input.events) {
        const provenance = assertEventWork(event, input.work);
        if (!provenance.ok) return provenance;
      }

      try {
        await transaction.query(
          `INSERT INTO public.signals_organization_organizations
            (id,name,slug,status,created_at,updated_at)
           VALUES ($1::uuid,$2,$3,$4,$5,$6)`,
          [
            input.organization.id,
            input.organization.name,
            input.organization.slug,
            input.organization.status,
            input.organization.createdAt,
            input.organization.updatedAt,
          ],
        );

        await transaction.query(
          `INSERT INTO public.signals_organization_memberships
            (id,organization_id,identity_id,role,status,created_at,updated_at,revoked_at)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8)`,
          [
            input.ownerMembership.id,
            input.ownerMembership.organizationId,
            input.ownerMembership.identityId,
            input.ownerMembership.role,
            input.ownerMembership.status,
            input.ownerMembership.createdAt,
            input.ownerMembership.updatedAt,
            input.ownerMembership.revokedAt,
          ],
        );

        for (const event of input.events) {
          const enqueued = await enqueue(transaction, event);
          if (!enqueued.ok) return enqueued;
        }

        return ok(undefined);
      } catch (cause) {
        return err(map(cause));
      }
    }, input.signal);
  }
}
