import { describe, expect, it } from 'vitest';
import {
  CancelJob,
  CompleteJob,
  FailJob,
  RetryJob,
  StartJob,
  SubmitWorkflowJob,
  type TransitionJob,
} from '../../src/modules/jobs/app/index.js';
import {
  InMemoryJobReader,
  InMemoryJobStore,
  InMemoryJobWriter,
} from '../../src/modules/jobs/infra/in-memory/index.js';
import { InMemoryEventBus } from '../../src/platform/events/in-memory-event-bus.js';
import { SystemClock } from '../../src/shared/clock/index.js';
import { ok } from '../../src/shared/errors/index.js';
import type { Envelope } from '../../src/shared/events/index.js';
import { V7, type ID } from '../../src/shared/id/index.js';
import { SecretString } from '../../src/shared/secret/index.js';
import {
  DOCUMENT_PROCESSING_JOB_KIND,
  decodeJobEvent,
} from '../../src/workflows/document-processing/infra/job-events.js';
import { newId, value, work } from '../support/adapter-contract.js';

/**
 * Consumer-driven contract: the events Jobs actually emits must decode with
 * the document-processing workflow's own decoder. Jobs is exercised through
 * its real commands, so renaming or dropping a payload field the workflow
 * reads fails here rather than silently stranding documents.
 */
function jobs() {
  const store = new InMemoryJobStore();
  const bus = new InMemoryEventBus();
  const emitted: Envelope[] = [];
  bus.subscribe('contract', async (event) => {
    emitted.push(event);
    return ok(undefined);
  });
  const clock = new SystemClock();
  const dependencies = {
    clock,
    ids: new V7(clock),
    access: {
      find: async (_token: SecretString, organizationId: ID) =>
        ok({ organizationId, identityId: newId(), role: 'owner' as const }),
    },
    jobs: new InMemoryJobReader(store),
    writer: new InMemoryJobWriter(store, bus),
  };
  return { dependencies, emitted };
}

async function transition(
  command: TransitionJob,
  operationName: string,
  organizationId: ID,
  jobId: ID,
  failureCode?: string,
) {
  value(
    await command.execute({
      sessionToken: new SecretString('contract-session'),
      organizationId,
      jobId,
      failureCode,
      work: work(operationName),
    }),
  );
}

describe('Jobs events consumed by the document-processing workflow', () => {
  it('decode into the outcomes the workflow acts on', async () => {
    const { dependencies, emitted } = jobs();
    const organizationId = newId();
    const documentId = newId();
    const submitted = value(
      await new SubmitWorkflowJob(dependencies).execute({
        organizationId,
        kind: DOCUMENT_PROCESSING_JOB_KIND,
        subject: { type: 'document', id: documentId },
        maxAttempts: 3,
        work: work('job.submit.workflow'),
      }),
    );
    const jobId = submitted.jobId;
    await transition(new StartJob(dependencies), 'job.start', organizationId, jobId);
    await transition(new FailJob(dependencies), 'job.fail', organizationId, jobId, 'provider.timeout');
    await transition(new RetryJob(dependencies), 'job.retry', organizationId, jobId);
    await transition(new StartJob(dependencies), 'job.start', organizationId, jobId);
    await transition(new CompleteJob(dependencies), 'job.complete', organizationId, jobId);

    const decoded = emitted.map((event) => [event.type, value(decodeJobEvent(event))]);

    const target = { organizationId, documentId, jobId };
    expect(decoded).toEqual([
      ['job.submitted.v1', null],
      ['job.started.v1', null],
      ['job.failed.v1', { action: 'fail', ...target, attempt: 1, failureCode: 'provider.timeout' }],
      ['job.retried.v1', { action: 'retry', ...target, attempt: 1 }],
      ['job.started.v1', null],
      ['job.completed.v1', { action: 'complete', ...target, attempt: 2 }],
    ]);
  });

  it('decode a cancellation as a failure the workflow records', async () => {
    const { dependencies, emitted } = jobs();
    const organizationId = newId();
    const documentId = newId();
    const { jobId } = value(
      await new SubmitWorkflowJob(dependencies).execute({
        organizationId,
        kind: DOCUMENT_PROCESSING_JOB_KIND,
        subject: { type: 'document', id: documentId },
        work: work('job.submit.workflow'),
      }),
    );

    await transition(new CancelJob(dependencies), 'job.cancel', organizationId, jobId);

    expect(value(decodeJobEvent(emitted.at(-1)!))).toEqual({
      action: 'fail',
      organizationId,
      documentId,
      jobId,
      attempt: 0,
      failureCode: 'job.canceled',
    });
  });

  it('ignore jobs of other kinds even when their subject is a document', async () => {
    const { dependencies, emitted } = jobs();
    const organizationId = newId();
    const { jobId } = value(
      await new SubmitWorkflowJob(dependencies).execute({
        organizationId,
        kind: 'document.thumbnail',
        subject: { type: 'document', id: newId() },
        work: work('job.submit.workflow'),
      }),
    );
    await transition(new StartJob(dependencies), 'job.start', organizationId, jobId);
    await transition(new CompleteJob(dependencies), 'job.complete', organizationId, jobId);

    expect(emitted.map((event) => value(decodeJobEvent(event)))).toEqual([null, null, null]);
  });
});
