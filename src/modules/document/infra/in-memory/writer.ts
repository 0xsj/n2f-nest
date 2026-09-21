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
import type { DocumentCommit, DocumentWriter } from '../../app/index.js';
import { InMemoryDocumentStore } from './store.js';

@Injectable()
export class InMemoryDocumentWriter implements DocumentWriter {
  constructor(
    private readonly store: InMemoryDocumentStore,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async commit(input: DocumentCommit): Promise<Result<void, Failure>> {
    const provenance = assertEventWork(input.event, input.work);
    if (!provenance.ok) return provenance;

    const previous = this.store.documentById(input.document.id);
    if (input.mode === 'create' && previous) {
      return err(
        failure('conflict', 'document already exists', {
          type: 'document.already_exists',
        }),
      );
    }
    if (input.mode === 'update' && !previous) {
      return err(
        failure('not_found', 'document was not found', {
          type: 'document.not_found',
        }),
      );
    }
    if (
      previous &&
      previous.organizationId !== input.document.organizationId
    ) {
      return err(
        failure('conflict', 'document organization cannot change', {
          type: 'document.organization_mismatch',
        }),
      );
    }

    if (input.mode === 'create') this.store.add(input.document);
    else this.store.replace(input.document);

    const published = await this.events.publish(input.event, input.signal);
    if (!published.ok) {
      if (previous) this.store.replace(previous);
      else {
        // The store intentionally has no public delete operation; a failed
        // create is rolled back by replacing the store with a fresh snapshot.
        this.store.remove(input.document.id);
      }
      return published;
    }
    return ok(undefined);
  }
}
