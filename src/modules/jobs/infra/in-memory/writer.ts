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
import { InMemoryJobStore } from './store.js';

@Injectable()
export class InMemoryJobWriter implements JobWriter {
  constructor(
    private readonly store: InMemoryJobStore,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async commit(input: JobCommit): Promise<Result<void, Failure>> {
    const provenance = assertEventWork(input.event, input.work);
    if (!provenance.ok) return provenance;

    const previous = this.store.jobById(input.job.id);
    if (input.mode === 'create' && previous) {
      return err(failure('conflict', 'job already exists', { type: 'job.already_exists' }));
    }
    if (input.mode === 'update' && !previous) {
      return err(failure('not_found', 'job was not found', { type: 'job.not_found' }));
    }
    if (previous && previous.organizationId !== input.job.organizationId) {
      return err(
        failure('conflict', 'job organization cannot change', {
          type: 'job.organization_mismatch',
        }),
      );
    }

    if (input.mode === 'create') this.store.add(input.job);
    else this.store.replace(input.job);
    const published = await this.events.publish(input.event, input.signal);
    if (!published.ok) {
      if (previous) this.store.replace(previous);
      else this.store.remove(input.job.id);
      return published;
    }
    return ok(undefined);
  }
}
