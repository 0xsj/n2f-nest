import { err, failure, ok, type Failure, type Result } from '../../../shared/errors/index.js';
import type { Envelope } from '../../../shared/events/index.js';
import { parse, type ID } from '../../../shared/id/index.js';

/** The job kind this workflow submits; outcomes of other kinds are not its concern. */
export const DOCUMENT_PROCESSING_JOB_KIND = 'document.process';

/** A job outcome, in the workflow's terms, that changes a document's processing state. */
type JobTarget = Readonly<{
  organizationId: ID;
  documentId: ID;
  /** The job: the document's processing run. */
  jobId: ID;
  /** The job's attempt count when the event was emitted; orders outcomes. */
  attempt: number;
}>;

export type JobOutcome =
  | (JobTarget & Readonly<{ action: 'retry' | 'complete' }>)
  | (JobTarget &
      Readonly<{
        action: 'fail';
        /** The job's failure code; a canceled job has none of its own. */
        failureCode: string;
      }>);

const ACTIONS: Readonly<Record<string, JobOutcome['action'] | undefined>> = {
  'job.retried.v1': 'retry',
  'job.completed.v1': 'complete',
  'job.failed.v1': 'fail',
  'job.canceled.v1': 'fail',
};

const invalid = (field: string): Failure =>
  failure('invalid', `job event ${field} is invalid`, { type: 'workflow.invalid_event' });

function idAt(value: unknown, field: string): Result<ID, Failure> {
  return typeof value === 'string' ? parse(value) : err(invalid(field));
}

/**
 * The workflow's own decoder for the Jobs events it consumes. It reads only the
 * fields it needs and ignores everything else, so Jobs can add fields freely;
 * `test/contracts/job-events.contract.spec.ts` proves the events Jobs actually
 * emits still decode. Returns null for events this workflow does not act on.
 */
export function decodeJobEvent(event: Envelope): Result<JobOutcome | null, Failure> {
  const action = ACTIONS[event.type];
  if (!action) return ok(null);

  const payload = event.payload();
  if (payload.kind !== DOCUMENT_PROCESSING_JOB_KIND) return ok(null);
  const subject = payload.subject;
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) return ok(null);
  const { type, id } = subject as { type?: unknown; id?: unknown };
  if (type !== 'document') return ok(null);

  const documentId = idAt(id, 'subject.id');
  if (!documentId.ok) return documentId;
  const organizationId = idAt(payload.organization_id, 'organization_id');
  if (!organizationId.ok) return organizationId;
  const jobId = idAt(payload.job_id, 'job_id');
  if (!jobId.ok) return jobId;
  const attempt = payload.attempts;
  if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 0) {
    return err(invalid('attempts'));
  }
  const target = {
    organizationId: organizationId.value,
    documentId: documentId.value,
    jobId: jobId.value,
    attempt,
  };
  return ok(
    action === 'fail'
      ? {
          action,
          ...target,
          failureCode:
            typeof payload.failure_code === 'string' ? payload.failure_code : 'job.canceled',
        }
      : { action, ...target },
  );
}
