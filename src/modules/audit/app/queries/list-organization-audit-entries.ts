import { err, ok, typedFailure, type Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import { position, request, window, type Page } from '../../../../shared/pagination/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type { AuditEntryReader, AuditOrganizationAccessReader } from '../ports/index.js';
import { dependencyFailure, type AuditApplicationFailure } from '../failures.js';
import { view, type AuditEntryView } from './list-audit-entries.js';

export type ListOrganizationAuditEntriesQuery = Readonly<{
  sessionToken: SecretString;
  organizationId: ID;
  /** Page size as received (1–100, default 25). */
  limit?: string;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
  signal?: AbortSignal;
}>;

export type ListOrganizationAuditEntriesDependencies = Readonly<{
  access: AuditOrganizationAccessReader;
  entries: AuditEntryReader;
}>;

/**
 * One organization's audit trail, oldest first. Audit records who did what
 * across the organization, so only its owners and admins may read it.
 */
export class ListOrganizationAuditEntries {
  constructor(private readonly dependencies: ListOrganizationAuditEntriesDependencies) {}

  async execute(
    query: ListOrganizationAuditEntriesQuery,
  ): Promise<Result<Page<AuditEntryView>, AuditApplicationFailure>> {
    const access = await this.dependencies.access.find(
      query.sessionToken,
      query.organizationId,
      query.signal,
    );
    if (!access.ok) return err(dependencyFailure(access.error, 'organization.access.find'));
    if (access.value === null || (access.value.role !== 'owner' && access.value.role !== 'admin')) {
      return err(
        typedFailure(
          'forbidden',
          'audit.access_forbidden',
          'only organization owners and admins can read the audit trail',
        ),
      );
    }

    const scope = `audit:${query.organizationId}`;
    const page = request(scope, query.limit, query.cursor);
    if (!page.ok) {
      return err(typedFailure('invalid', 'audit.invalid_page', 'page size or cursor is invalid'));
    }
    const entries = await this.dependencies.entries.listForTenant(
      query.organizationId,
      page.value,
      query.signal,
    );
    if (!entries.ok) return err(dependencyFailure(entries.error, 'audit.listForTenant'));
    const windowed = window(entries.value, page.value.limit, scope, (entry) =>
      position(entry.recordedAt, entry.id),
    );
    if (!windowed.ok) return err(dependencyFailure(windowed.error, 'pagination.window'));
    return ok({ ...windowed.value, items: windowed.value.items.map(view) });
  }
}
