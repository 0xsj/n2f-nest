import { describe, expect, it } from 'vitest';
import { InMemoryEventBus } from '../../../../platform/events/in-memory-event-bus.js';
import { SystemClock } from '../../../../shared/clock/index.js';
import { ok } from '../../../../shared/errors/index.js';
import { V7 } from '../../../../shared/id/index.js';
import { event, newId, value, work } from '../../../../../test/support/adapter-contract.js';
import { Job } from '../../domain/index.js';
import { InMemoryJobReader, InMemoryJobStore, InMemoryJobWriter } from '../../infra/in-memory/index.js';
import type { JobReader } from '../ports/index.js';
import { SubmitWorkflowJob } from './submit-workflow-job.js';

describe('SubmitWorkflowJob', () => {
  it('returns the concurrent winner instead of a conflict when both submissions saw no job', async () => {
    const store = new InMemoryJobStore();
    const writer = new InMemoryJobWriter(store, new InMemoryEventBus());
    const organizationId = newId();
    const subject = { type: 'document', id: newId() };

    // The other submission commits between this one's read and its write.
    const winner = value(
      Job.create({
        id: newId(),
        organizationId,
        kind: 'document.process',
        subject,
        createdAt: new Date(),
      }),
    );
    const winnerWork = work('job.submit.workflow');
    value(
      await writer.commit({
        mode: 'create',
        job: winner,
        event: event('job.submitted.v1', winnerWork),
        work: winnerWork,
      }),
    );
    const reader = new InMemoryJobReader(store);
    let reads = 0;
    const staleFirstRead: JobReader = {
      findById: reader.findById.bind(reader),
      listForOrganization: reader.listForOrganization.bind(reader),
      listRunningStartedBefore: reader.listRunningStartedBefore.bind(reader),
      findOpenBySubject: (organization, kind, jobSubject) =>
        reads++ === 0
          ? Promise.resolve(ok(null))
          : reader.findOpenBySubject(organization, kind, jobSubject),
    };

    const result = await new SubmitWorkflowJob({
      clock: new SystemClock(),
      ids: new V7(new SystemClock()),
      jobs: staleFirstRead,
      writer,
    }).execute({
      organizationId,
      kind: 'document.process',
      subject,
      work: work('job.submit.workflow'),
    });

    expect(result).toEqual(ok({ jobId: winner.id, status: 'queued', created: false }));
    expect(store.jobsForOrganization(organizationId)).toHaveLength(1);
  });

  describe('ensures one open job per subject', () => {
    const clock = new SystemClock();
    function setup() {
      const store = new InMemoryJobStore();
      const emitted: string[] = [];
      const bus = new InMemoryEventBus();
      bus.subscribe('spec', async (event) => {
        emitted.push(event.type);
        return ok(undefined);
      });
      const writer = new InMemoryJobWriter(store, bus);
      const reader = new InMemoryJobReader(store);
      const submit = new SubmitWorkflowJob({ clock, ids: new V7(clock), jobs: reader, writer });
      const organizationId = newId();
      const subject = { type: 'document', id: newId() };
      const ensure = () =>
        submit.execute({
          organizationId,
          kind: 'document.process',
          subject,
          maxAttempts: 2,
          work: work('job.submit.workflow'),
        });
      /** Apply a domain transition to the stored job, as an operator would. */
      const transition = async (jobId: string, apply: (job: Job) => ReturnType<Job['start']>) => {
        const loaded = value(await reader.findById(jobId as never))!;
        const context = work('job.transition');
        value(
          await writer.commit({
            mode: 'update',
            job: value(apply(loaded)),
            event: event('job.transitioned.v1', context),
            work: context,
          }),
        );
      };
      return { ensure, transition, emitted, store, organizationId };
    }

    it('returns a queued or running job unchanged', async () => {
      const { ensure, transition } = setup();
      const first = value(await ensure());
      await transition(first.jobId, (job) => job.start(new Date()));

      expect(value(await ensure())).toEqual({ jobId: first.jobId, status: 'running', created: false });
    });

    it('retries a failed job that has attempts left instead of creating another', async () => {
      const { ensure, transition, emitted } = setup();
      const first = value(await ensure());
      await transition(first.jobId, (job) => job.start(new Date()));
      await transition(first.jobId, (job) => job.fail(new Date(), 'provider.timeout'));

      const again = value(await ensure());

      expect(again).toEqual({ jobId: first.jobId, status: 'queued', created: false });
      expect(emitted.at(-1)).toBe('job.retried.v1');
    });

    it.each([
      ['canceled', (job: Job) => job.cancel(new Date())],
      ['succeeded', (job: Job) => value(job.start(new Date())).complete(new Date())],
    ] as const)('creates a new job once the previous one %s', async (_state, finish) => {
      const { ensure, transition, store, organizationId } = setup();
      const first = value(await ensure());
      await transition(first.jobId, finish);

      const next = value(await ensure());

      expect(next.created).toBe(true);
      expect(next.jobId).not.toBe(first.jobId);
      expect(store.jobsForOrganization(organizationId)).toHaveLength(2);
    });

    it('creates a new job once the previous one exhausted its attempts', async () => {
      const { ensure, transition } = setup();
      const first = value(await ensure());
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await transition(first.jobId, (job) => job.start(new Date()));
        await transition(first.jobId, (job) => job.fail(new Date(), 'provider.timeout'));
        if (attempt === 0) await transition(first.jobId, (job) => job.retry(new Date()));
      }

      const next = value(await ensure());

      expect(next.created).toBe(true);
      expect(next.jobId).not.toBe(first.jobId);
    });
  });
});
