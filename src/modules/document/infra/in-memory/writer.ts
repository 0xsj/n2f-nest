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
import { documentExists, documentNotFound, staleWrite } from '../failures.js';
import { InMemoryDocumentStore } from './store.js';

/** Mirrors the PostgreSQL writer, including version-checked updates. */
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
    if (input.mode === 'create' && previous) return err(documentExists());
    if (input.mode === 'update') {
      if (!previous) return err(documentNotFound());
      if (previous.organizationId !== input.document.organizationId) {
        return err(
          failure('conflict', 'document organization cannot change', {
            type: 'document.organization_mismatch',
          }),
        );
      }
      if (previous.version !== input.document.version) return err(staleWrite());
    }

    if (input.mode === 'create') this.store.add(input.document.saved());
    else this.store.replace(input.document.saved());

    const published = await this.events.publish(input.event, input.signal);
    if (!published.ok) {
      if (previous) this.store.replace(previous);
      else this.store.remove(input.document.id);
      return published;
    }
    return ok(undefined);
  }
}
