import {
  err,
  failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type { Job } from '../../domain/index.js';
import type { JobOrganizationAccessReader, JobReader } from '../ports/index.js';
import { dependencyFailure, type JobsApplicationFailure } from '../failures.js';

export type ListJobsQuery = Readonly<{
  sessionToken: SecretString;
  organizationId: ID;
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
  ): Promise<Result<readonly Job[], JobsApplicationFailure>> {
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
      query.signal,
    );
    return jobs.ok
      ? jobs
      : err(dependencyFailure(jobs.error, 'job.listForOrganization'));
  }
}
