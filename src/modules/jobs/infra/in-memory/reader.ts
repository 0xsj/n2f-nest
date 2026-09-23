import { Injectable } from '@nestjs/common';
import { ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import { keysetPage, type After } from '../../../../shared/pagination/index.js';
import type { JobReader } from '../../app/index.js';
import type { Job, JobSubject } from '../../domain/index.js';
import { InMemoryJobStore } from './store.js';

@Injectable()
export class InMemoryJobReader implements JobReader {
  constructor(private readonly store: InMemoryJobStore) {}

  async findById(id: ID): Promise<Result<Job | null, Failure>> {
    return ok(this.store.jobById(id) ?? null);
  }

  async findOpenBySubject(
    organizationId: ID,
    kind: string,
    subject: JobSubject,
  ): Promise<Result<Job | null, Failure>> {
    return ok(this.store.openJobBySubject(organizationId, kind, subject) ?? null);
  }

  async listRunningStartedBefore(
    startedBefore: Date,
    limit: number,
  ): Promise<Result<readonly Job[], Failure>> {
    return ok(this.store.runningStartedBefore(startedBefore, limit));
  }

  async listForOrganization(
    organizationId: ID,
    page: Readonly<{ limit: number; after?: After }>,
  ): Promise<Result<readonly Job[], Failure>> {
    return ok(
      keysetPage(
        this.store.jobsForOrganization(organizationId),
        (job) => ({ at: job.createdAt, id: job.id }),
        page,
      ),
    );
  }
}
