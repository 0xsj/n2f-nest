import { describe, expect, it } from 'vitest';
import { InMemoryEventBus } from '../../../../platform/events/in-memory-event-bus.js';
import { FakeClock } from '../../../../shared/clock/index.js';
import { ok } from '../../../../shared/errors/index.js';
import { V7 } from '../../../../shared/id/index.js';
import { event, newId, value, work } from '../../../../../test/support/adapter-contract.js';
import { Job } from '../../domain/index.js';
import { InMemoryJobReader, InMemoryJobStore, InMemoryJobWriter } from '../../infra/in-memory/index.js';
import type { JobReader } from '../ports/index.js';
import { ExpireStaleJobs, JOB_TIMED_OUT } from './expire-stale-jobs.js';

const HOUR = 3600 * 1000;

function setup() {
  const clock = new FakeClock(new Date('2026-09-23T12:00:00.000Z'));
  const store = new InMemoryJobStore();
  const emitted: string[] = [];
  const bus = new InMemoryEventBus();
  bus.subscribe('spec', async (published) => {
    emitted.push(published.type);
    return ok(undefined);
  });
  const writer = new InMemoryJobWriter(store, bus);
  const reader = new InMemoryJobReader(store);
  /** A job created and moved to `status` at `hoursAgo`. */
  const job = async (status: 'queued' | 'running', hoursAgo: number) => {
    const at = new Date(clock.now().getTime() - hoursAgo * HOUR);
    let created = value(Job.create({ id: newId(), organizationId: newId(), kind: 'document.process', createdAt: at }));
    const create = work('job.submit');
    value(await writer.commit({ mode: 'create', job: created, event: event('job.submitted.v1', create), work: create }));
    if (status === 'running') {
      created = value(value(await reader.findById(created.id))!.start(at));
      const start = work('job.start');
      value(await writer.commit({ mode: 'update', job: created, event: event('job.started.v1', start), work: start }));
    }
    return created.id;
  };
  const expire = (jobs: JobReader = reader) =>
    new ExpireStaleJobs({ clock, ids: new V7(clock), jobs, writer }).execute({
      runningTimeoutMs: HOUR,
      limit: 10,
      work: work('job.expire'),
    });
  return { job, expire, reader, emitted };
}

describe('ExpireStaleJobs', () => {
  it('fails only jobs running past the timeout, as an ordinary job failure', async () => {
    const { job, expire, reader, emitted } = setup();
    const stale = await job('running', 2);
    const recent = await job('running', 0.25);
    const queued = await job('queued', 5);

    expect(value(await expire())).toEqual({ expired: 1, skipped: 0 });

    const expired = value(await reader.findById(stale))!;
    expect(expired).toMatchObject({ status: 'failed', failureCode: JOB_TIMED_OUT });
    expect(value(await reader.findById(recent))!.status).toBe('running');
    expect(value(await reader.findById(queued))!.status).toBe('queued');
    expect(emitted.at(-1)).toBe('job.failed.v1');
  });

  it('skips a job another process changed after it was listed', async () => {
    const { job, expire, reader } = setup();
    const stale = await job('running', 2);
    const listed = value(await reader.listRunningStartedBefore(new Date(), 10));
    await expire();

    const replayed: JobReader = {
      ...reader,
      findById: reader.findById.bind(reader),
      findOpenBySubject: reader.findOpenBySubject.bind(reader),
      listForOrganization: reader.listForOrganization.bind(reader),
      listRunningStartedBefore: async () => ok(listed),
    };
    expect(value(await expire(replayed))).toEqual({ expired: 0, skipped: 1 });
    expect(value(await reader.findById(stale))!.status).toBe('failed');
  });
});
