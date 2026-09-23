import { describe, expect, it } from 'vitest';
import { InMemoryEventBus } from '../../../platform/events/in-memory-event-bus.js';
import {
  HOUR,
  event,
  newId,
  postgresContract,
  value,
  work,
} from '../../../../test/support/adapter-contract.js';
import type { DocumentReader, DocumentWriter } from '../app/ports/index.js';
import { Document } from '../domain/index.js';
import {
  InMemoryDocumentReader,
  InMemoryDocumentStore,
  InMemoryDocumentWriter,
} from './in-memory/index.js';
import { PostgresDocumentReader, PostgresDocumentWriter } from './postgres/index.js';

/** One behavioral contract for every Document storage adapter. */
type Adapters = Readonly<{
  documents: DocumentReader;
  writer: DocumentWriter;
}>;

function contract(name: string, adapters: () => Adapters) {
  describe(`${name} Document adapters`, () => {
    const run = newId();

    async function processing() {
      const a = adapters();
      const createdAt = new Date(Date.now() - HOUR);
      const created = value(
        Document.create({
          id: newId(),
          organizationId: newId(),
          name: 'contract.pdf',
          createdAt,
        }),
      );
      const create = work('document.create');
      value(
        await a.writer.commit({
          mode: 'create',
          document: created,
          event: event('document.created.v1', create),
          work: create,
        }),
      );
      const loaded = value(await a.documents.findById(created.id))!;
      const begin = work('document.processing.begin');
      value(
        await a.writer.commit({
          mode: 'update',
          document: value(loaded.beginProcessing(new Date(Date.now() - HOUR / 2), run)),
          event: event('document.processing_started.v1', begin),
          work: begin,
        }),
      );
      return value(await a.documents.findById(created.id))!;
    }

    function update(document: Document, type: string) {
      const context = work('document.update');
      return adapters().writer.commit({
        mode: 'update',
        document,
        event: event(type, context),
        work: context,
      });
    }

    it('reports a duplicate document ID as document.already_exists', async () => {
      const existing = await processing();
      const context = work('document.create');

      const duplicate = await adapters().writer.commit({
        mode: 'create',
        document: value(
          Document.create({
            id: existing.id,
            organizationId: existing.organizationId,
            name: 'again.pdf',
            createdAt: new Date(),
          }),
        ),
        event: event('document.created.v1', context),
        work: context,
      });

      expect(duplicate).toMatchObject({
        ok: false,
        error: { kind: 'conflict', type: 'document.already_exists' },
      });
    });

    it('pages the documents of an organization in (createdAt, id) order', async () => {
      const organizationId = newId();
      const createdAt = new Date(Date.now() - HOUR);
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const created = value(
          Document.create({ id: newId(), organizationId, name: `page-${index}.pdf`, createdAt }),
        );
        const context = work('document.create');
        value(
          await adapters().writer.commit({
            mode: 'create',
            document: created,
            event: event('document.created.v1', context),
            work: context,
          }),
        );
        ids.push(created.id);
      }
      ids.sort();

      const first = value(await adapters().documents.listForOrganization(organizationId, { limit: 2 }));
      const last = first[1]!;
      const second = value(
        await adapters().documents.listForOrganization(organizationId, {
          limit: 2,
          after: { at: last.createdAt, id: last.id },
        }),
      );

      // limit + 1 rows tell the caller another page exists.
      expect(first.map((document) => document.id)).toEqual(ids);
      expect(second.map((document) => document.id)).toEqual([ids[2]]);
    });

    it('does not let a completion read before an archive bring the document back', async () => {
      const loaded = await processing();
      const at = new Date();

      const archived = await update(value(loaded.archive(at)), 'document.archived.v1');
      const completed = await update(
        value(loaded.applyProcessingOutcome(at, { run, attempt: 1, result: 'succeeded' })),
        'document.processing_completed.v1',
      );

      expect(archived.ok).toBe(true);
      expect(completed).toMatchObject({
        ok: false,
        error: { kind: 'conflict', type: 'document.stale_write' },
      });
      const stored = value(await adapters().documents.findById(loaded.id))!;
      expect(stored.status).toBe('archived');
      expect(stored.archivedAt).not.toBeNull();
    });
  });
}

let memory: Adapters | undefined;
contract('in-memory', () => {
  if (!memory) {
    const store = new InMemoryDocumentStore();
    memory = {
      documents: new InMemoryDocumentReader(store),
      writer: new InMemoryDocumentWriter(store, new InMemoryEventBus()),
    };
  }
  return memory;
});

postgresContract(
  (database): Adapters => ({
    documents: new PostgresDocumentReader(database),
    writer: new PostgresDocumentWriter(database),
  }),
  (adapters) => contract('PostgreSQL', adapters),
);
