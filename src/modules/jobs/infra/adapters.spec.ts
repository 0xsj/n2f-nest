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
import { Job } from '../domain/index.js';
import { InMemoryJobReader } from './in-memory/reader.js';
import { InMemoryJobStore } from './in-memory/store.js';
import { InMemoryJobWriter } from './in-memory/writer.js';

function id(value: string): ID {
  const result = parse(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function work(workId = id('00000000-0000-7000-8000-000000000021')) {
  const result = restoreWork({
    workId,
    correlationId: id('00000000-0000-7000-8000-000000000022'),
    correlationSource: 'local',
    operation: operation('job.submit').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'request',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function jobFixture() {
  const result = Job.create({
    id: id('00000000-0000-7000-8000-000000000023'),
    organizationId: id('00000000-0000-7000-8000-000000000024'),
    kind: 'document.process',
    subject: {
      type: 'document',
      id: id('00000000-0000-7000-8000-000000000025'),
    },
    maxAttempts: 3,
    createdAt: new Date('2026-09-22T00:00:00.000Z'),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function event(job: Job, context = work()) {
  const result = Envelope.create(
    id('00000000-0000-7000-8000-000000000026'),
    'job.submitted.v1',
    job.createdAt.getTime(),
    context,
    { job_id: job.id, organization_id: job.organizationId, kind: job.kind },
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function commit(job: Job, context = work()) {
  return {
    mode: 'create' as const,
    job,
    event: event(job, context),
    work: context,
  };
}

describe('Jobs in-memory adapter contract', () => {
  it('writes, publishes and reads a job through the application ports', async () => {
    const store = new InMemoryJobStore();
    const bus = new InMemoryEventBus();
    let publishedId: ID | undefined;
    bus.subscribe(async (published) => {
      publishedId = published.id;
      return ok(undefined);
    });

    const job = jobFixture();
    const writer = new InMemoryJobWriter(store, bus);
    const reader = new InMemoryJobReader(store);
    const result = await writer.commit(commit(job));

    expect(result).toEqual(ok(undefined));
    expect(publishedId).toBe(id('00000000-0000-7000-8000-000000000026'));

    const read = await reader.findById(job.id);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value?.kind).toBe('document.process');
      expect(read.value?.subject?.type).toBe('document');
    }
  });

  it('rolls back state when event publication fails', async () => {
    const store = new InMemoryJobStore();
    const bus = new InMemoryEventBus();
    bus.subscribe(async () =>
      err(failure('unavailable', 'test publisher unavailable', { type: 'test.publisher' })),
    );
    const job = jobFixture();
    const writer = new InMemoryJobWriter(store, bus);
    const reader = new InMemoryJobReader(store);

    const result = await writer.commit(commit(job));

    expect(result.ok).toBe(false);
    expect((await reader.findById(job.id))).toEqual(ok(null));
  });
});
