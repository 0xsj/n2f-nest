/** Event names owned by the Jobs bounded context. */
export const JOB_EVENT_TYPES = Object.freeze({
  submitted: 'job.submitted.v1',
  started: 'job.started.v1',
  completed: 'job.completed.v1',
  failed: 'job.failed.v1',
  retried: 'job.retried.v1',
  canceled: 'job.canceled.v1',
} as const);

export type JobEventType =
  (typeof JOB_EVENT_TYPES)[keyof typeof JOB_EVENT_TYPES];
