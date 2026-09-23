import { describe, expect, it } from 'vitest';
import { InMemoryEventBus } from '../../../platform/events/in-memory-event-bus.js';
import { err, failure, ok } from '../../../shared/errors/index.js';
import { Envelope } from '../../../shared/events/index.js';
import { parse, type ID } from '../../../shared/id/index.js';
import {
  anonymous,
  attribution,
  operation,
  restoreWork,
} from '../../../shared/provenance/index.js';
import { Document } from '../domain/index.js';
import { InMemoryDocumentReader } from './in-memory/reader.js';
import { InMemoryDocumentStore } from './in-memory/store.js';
import { InMemoryDocumentWriter } from './in-memory/writer.js';

function id(value: string): ID {
  const result = parse(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function work(workId = id('00000000-0000-7000-8000-000000000001')) {
  const result = restoreWork({
    workId,
    correlationId: id('00000000-0000-7000-8000-000000000002'),
    correlationSource: 'local',
    operation: operation('document.create').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'request',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function documentFixture() {
  const result = Document.create({
    id: id('00000000-0000-7000-8000-000000000003'),
    organizationId: id('00000000-0000-7000-8000-000000000004'),
    name: 'adapter contract document',
    storageKey: 'documents/contract.txt',
    createdAt: new Date('2026-09-22T00:00:00.000Z'),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function event(document: Document, context = work()) {
  const result = Envelope.create(
    id('00000000-0000-7000-8000-000000000005'),
    'document.created.v1',
    document.createdAt.getTime(),
    context,
    { document_id: document.id, organization_id: document.organizationId },
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function commit(document: Document, context = work()) {
  return {
    mode: 'create' as const,
    document,
    event: event(document, context),
    work: context,
  };
}

describe('Document in-memory adapter contract', () => {
  it('writes, publishes and reads a document through the application ports', async () => {
    const store = new InMemoryDocumentStore();
    const bus = new InMemoryEventBus();
    let publishedId: ID | undefined;
    bus.subscribe('spec', async (published) => {
      publishedId = published.id;
      return ok(undefined);
    });

    const document = documentFixture();
    const writer = new InMemoryDocumentWriter(store, bus);
    const reader = new InMemoryDocumentReader(store);
    const result = await writer.commit(commit(document));

    expect(result).toEqual(ok(undefined));
    expect(publishedId).toBe(id('00000000-0000-7000-8000-000000000005'));

    const read = await reader.findById(document.id);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value?.name).toBe('adapter contract document');
      expect(read.value?.storageKey).toBe('documents/contract.txt');
    }
  });

  it('rolls back state when event publication fails', async () => {
    const store = new InMemoryDocumentStore();
    const bus = new InMemoryEventBus();
    bus.subscribe('spec', async () =>
      err(failure('unavailable', 'test publisher unavailable', { type: 'test.publisher' })),
    );
    const document = documentFixture();
    const writer = new InMemoryDocumentWriter(store, bus);
    const reader = new InMemoryDocumentReader(store);

    const result = await writer.commit(commit(document));

    expect(result.ok).toBe(false);
    expect((await reader.findById(document.id))).toEqual(ok(null));
  });
});
