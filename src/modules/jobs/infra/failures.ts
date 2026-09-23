import { failure, type Failure } from '../../../shared/errors/index.js';

/** Another operation changed the job after this operation read it. */
export const staleWrite = (): Failure =>
  failure('conflict', 'job was changed by a concurrent operation', {
    type: 'job.stale_write',
  });

export const jobExists = (): Failure =>
  failure('conflict', 'job already exists', { type: 'job.already_exists' });

/** Another job already exists for the same organization, kind and subject. */
export const subjectTaken = (): Failure =>
  failure('conflict', 'a job already exists for this subject', {
    type: 'job.subject_taken',
  });

export const jobNotFound = (): Failure =>
  failure('not_found', 'job was not found', { type: 'job.not_found' });

export const CONSTRAINTS = Object.freeze({
  jobPkey: 'n2f_jobs_jobs_pkey',
  subject: 'n2f_jobs_jobs_open_subject',
});
