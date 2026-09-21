import { Injectable } from '@nestjs/common';
import { ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { JobReader } from '../../app/index.js';
import type { Job, JobSubject } from '../../domain/index.js';
import { InMemoryJobStore } from './store.js';

@Injectable()
export class InMemoryJobReader implements JobReader {
  constructor(private readonly store: InMemoryJobStore) {}

  async findById(id: ID): Promise<Result<Job | null, Failure>> {
    return ok(this.store.jobById(id) ?? null);
  }

  async findBySubject(
    organizationId: ID,
    kind: string,
    subject: JobSubject,
  ): Promise<Result<Job | null, Failure>> {
    return ok(this.store.jobBySubject(organizationId, kind, subject) ?? null);
  }

  async listForOrganization(
    organizationId: ID,
  ): Promise<Result<readonly Job[], Failure>> {
    return ok(this.store.jobsForOrganization(organizationId));
  }
}
