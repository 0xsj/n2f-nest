import { Inject, Injectable } from '@nestjs/common';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { assertEventWork } from '../../../../shared/events/index.js';
import {
  EVENT_BUS,
  type EventBus,
} from '../../../../platform/events/event-bus.js';
import type { JobCommit, JobWriter } from '../../app/index.js';
import { jobExists, jobNotFound, staleWrite, subjectTaken } from '../failures.js';
import { InMemoryJobStore } from './store.js';

/**
 * Mirrors the PostgreSQL writer: one job per organization, kind and subject,
 * and version-checked updates.
 */
@Injectable()
export class InMemoryJobWriter implements JobWriter {
  constructor(
    private readonly store: InMemoryJobStore,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async commit(input: JobCommit): Promise<Result<void, Failure>> {
    const provenance = assertEventWork(input.event, input.work);
    if (!provenance.ok) return provenance;
    const job = input.job;

    const previous = this.store.jobById(job.id);
    if (input.mode === 'create') {
      if (previous) return err(jobExists());
      if (job.subject && this.store.openJobBySubject(job.organizationId, job.kind, job.subject)) {
        return err(subjectTaken());
      }
    } else {
      if (!previous) return err(jobNotFound());
      if (previous.organizationId !== job.organizationId) {
        return err(
          failure('conflict', 'job organization cannot change', {
            type: 'job.organization_mismatch',
          }),
        );
      }
      if (previous.version !== job.version) return err(staleWrite());
    }

    if (input.mode === 'create') this.store.add(job.saved());
    else this.store.replace(job.saved());
    const published = await this.events.publish(input.event, input.signal);
    if (!published.ok) {
      if (previous) this.store.replace(previous);
      else this.store.remove(job.id);
      return published;
    }
    return ok(undefined);
  }
}
