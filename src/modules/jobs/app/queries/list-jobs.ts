import {
  err,
  failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import { position, request, window, type Page } from '../../../../shared/pagination/index.js';
import type { Job } from '../../domain/index.js';
import type { JobOrganizationAccessReader, JobReader } from '../ports/index.js';
import { dependencyFailure, invalidPage, type JobsApplicationFailure } from '../failures.js';

export type ListJobsQuery = Readonly<{
  sessionToken: SecretString;
  organizationId: ID;
  /** Page size as received (1–100, default 25). */
  limit?: string;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
  signal?: AbortSignal;
}>;

export type ListJobsDependencies = Readonly<{
  access: JobOrganizationAccessReader;
  jobs: JobReader;
}>;

export class ListJobs {
  constructor(private readonly dependencies: ListJobsDependencies) {}

  async execute(
    query: ListJobsQuery,
  ): Promise<Result<Page<Job>, JobsApplicationFailure>> {
    const scope = `jobs:${query.organizationId}`;
    const page = request(scope, query.limit, query.cursor);
    if (!page.ok) return err(invalidPage());
    const access = await this.dependencies.access.find(
      query.sessionToken,
      query.organizationId,
      query.signal,
    );
    if (!access.ok) return err(dependencyFailure(access.error, 'organization.access.find'));
    if (access.value === null) {
      return err(failure('forbidden', 'organization access is required', { type: 'job.access_forbidden' }));
    }
    const jobs = await this.dependencies.jobs.listForOrganization(
      query.organizationId,
      page.value,
      query.signal,
    );
    if (!jobs.ok) return err(dependencyFailure(jobs.error, 'job.listForOrganization'));
    const windowed = window(jobs.value, page.value.limit, scope, (job) =>
      position(job.createdAt, job.id),
    );
    return windowed.ok ? windowed : err(dependencyFailure(windowed.error, 'pagination.window'));
  }
}
