import { describe, expect, it } from 'vitest';
import { InMemoryEventBus } from '../../../platform/events/in-memory-event-bus.js';
import type { ID } from '../../../shared/id/index.js';
import {
  HOUR,
  event,
  newId,
  postgresContract,
  value,
  work,
} from '../../../../test/support/adapter-contract.js';
import type { JobReader, JobWriter } from '../app/ports/index.js';
import { Job } from '../domain/index.js';
import { InMemoryJobReader, InMemoryJobStore, InMemoryJobWriter } from './in-memory/index.js';
import { PostgresJobReader, PostgresJobWriter } from './postgres/index.js';

/** One behavioral contract for every Jobs storage adapter. */
type Adapters = Readonly<{
  jobs: JobReader;
  writer: JobWriter;
}>;

function contract(name: string, adapters: () => Adapters) {
  describe(`${name} Jobs adapters`, () => {
    async function submit(organizationId: ID, subjectId: ID = newId()) {
      const created = value(
        Job.create({
          id: newId(),
          organizationId,
          kind: 'document.process',
          subject: { type: 'document', id: subjectId },
          createdAt: new Date(Date.now() - HOUR),
        }),
      );
      const context = work('job.submit');
      const result = await adapters().writer.commit({
        mode: 'create',
        job: created,
        event: event('job.submitted.v1', context),
        work: context,
      });
      return { job: created, subjectId, result };
    }

    it('refuses a second job for the same subject as job.subject_taken', async () => {
      const organizationId = newId();
      const first = await submit(organizationId);
      expect(first.result.ok).toBe(true);

      const second = await submit(organizationId, first.subjectId);

      expect(second.result).toMatchObject({
        ok: false,
        error: { kind: 'conflict', type: 'job.subject_taken' },
      });
    });

    it('lets a subject have a new job once its previous job has finished', async () => {
      const organizationId = newId();
      const first = await submit(organizationId);
      const loaded = value(await adapters().jobs.findById(first.job.id))!;
      const cancel = work('job.cancel');
      value(
        await adapters().writer.commit({
          mode: 'update',
          job: value(loaded.cancel(new Date())),
          event: event('job.canceled.v1', cancel),
          work: cancel,
        }),
      );

      const second = await submit(organizationId, first.subjectId);

      expect(second.result.ok).toBe(true);
      expect(value(await adapters().jobs.findOpenBySubject(organizationId, 'document.process', {
        type: 'document',
        id: first.subjectId,
      }))?.id).toBe(second.job.id);
    });

    it('lists running jobs started before a cutoff, oldest first', async () => {
      const organizationId = newId();
      const { job } = await submit(organizationId);
      const loaded = value(await adapters().jobs.findById(job.id))!;
      const startedAt = new Date(Date.now() - 30 * 60 * 1000);
      const start = work('job.start');
      value(
        await adapters().writer.commit({
          mode: 'update',
          job: value(loaded.start(startedAt)),
          event: event('job.started.v1', start),
          work: start,
        }),
      );

      const before = value(await adapters().jobs.listRunningStartedBefore(new Date(), 10_000));
      const after = value(
        await adapters().jobs.listRunningStartedBefore(new Date(startedAt.getTime() - 1), 10_000),
      );

      expect(before.map((candidate) => candidate.id)).toContain(job.id);
      expect(after.map((candidate) => candidate.id)).not.toContain(job.id);
    });

    it('starts a job once when two starts read the same queued state', async () => {
      const { job } = await submit(newId());
      const loaded = value(await adapters().jobs.findById(job.id))!;
      const at = new Date();
      const start = () => {
        const context = work('job.start');
        return adapters().writer.commit({
          mode: 'update',
          job: value(loaded.start(at)),
          event: event('job.started.v1', context),
          work: context,
        });
      };

      const first = await start();
      const second = await start();

      expect(first.ok).toBe(true);
      expect(second).toMatchObject({
        ok: false,
        error: { kind: 'conflict', type: 'job.stale_write' },
      });
      const stored = value(await adapters().jobs.findById(job.id))!;
      expect(stored.status).toBe('running');
      expect(stored.attempts).toBe(1);
    });
  });
}

let memory: Adapters | undefined;
contract('in-memory', () => {
  if (!memory) {
    const store = new InMemoryJobStore();
    memory = {
      jobs: new InMemoryJobReader(store),
      writer: new InMemoryJobWriter(store, new InMemoryEventBus()),
    };
  }
  return memory;
});

postgresContract(
  (database): Adapters => ({
    jobs: new PostgresJobReader(database),
    writer: new PostgresJobWriter(database),
  }),
  (adapters) => contract('PostgreSQL', adapters),
);
