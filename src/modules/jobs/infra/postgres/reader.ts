import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import { map, type TransactionDatabase } from '../../../../shared/postgres/index.js';
import type { JobReader } from '../../app/index.js';
import { Job, type JobSubject } from '../../domain/index.js';

type JobRow = {
  job_id: string;
  organization_id: string;
  kind: string;
  subject_type: string | null;
  subject_id: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  failure_code: string | null;
};

function storedId(value: unknown): Result<ID, Failure> {
  return typeof value === 'string'
    ? parse(value)
    : err(
        failure('internal', 'stored job ID is invalid', {
          type: 'job.persistence_invalid',
        }),
      );
}

function restore(row: JobRow): Result<Job, Failure> {
  const jobId = storedId(row.job_id);
  if (!jobId.ok) return jobId;
  const organizationId = storedId(row.organization_id);
  if (!organizationId.ok) return organizationId;
  return Job.restore({
    id: jobId.value,
    organizationId: organizationId.value,
    kind: row.kind,
    subject:
      row.subject_type === null || row.subject_id === null
        ? null
        : { type: row.subject_type, id: row.subject_id as JobSubject['id'] },
    status: row.status as Job['status'],
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    failureCode: row.failure_code,
  });
}

const columns = `id AS job_id,
                 organization_id,
                 kind,
                 subject_type,
                 subject_id,
                 status,
                 attempts,
                 max_attempts,
                 created_at,
                 updated_at,
                 started_at,
                 finished_at,
                 failure_code`;

export class PostgresJobReader implements JobReader {
  constructor(private readonly database: TransactionDatabase) {}

  findById(id: ID, signal?: AbortSignal): Promise<Result<Job | null, Failure>> {
    return this.database.transaction(async (transaction) => {
      try {
        const result = await transaction.query<JobRow>(
          `SELECT ${columns} FROM public.n2f_jobs_jobs WHERE id=$1::uuid`,
          [id],
        );
        return result.rows[0] ? restore(result.rows[0]) : ok(null);
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }

  findBySubject(
    organizationId: ID,
    kind: string,
    subject: JobSubject,
    signal?: AbortSignal,
  ): Promise<Result<Job | null, Failure>> {
    return this.database.transaction(async (transaction) => {
      try {
        const result = await transaction.query<JobRow>(
          `SELECT ${columns}
             FROM public.n2f_jobs_jobs
            WHERE organization_id=$1::uuid
              AND kind=$2
              AND subject_type=$3
              AND subject_id=$4::uuid
            ORDER BY created_at,id
            LIMIT 1`,
          [organizationId, kind, subject.type, subject.id],
        );
        return result.rows[0] ? restore(result.rows[0]) : ok(null);
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }

  listForOrganization(
    organizationId: ID,
    signal?: AbortSignal,
  ): Promise<Result<readonly Job[], Failure>> {
    return this.database.transaction(async (transaction) => {
      try {
        const result = await transaction.query<JobRow>(
          `SELECT ${columns}
             FROM public.n2f_jobs_jobs
            WHERE organization_id=$1::uuid
            ORDER BY created_at,id`,
          [organizationId],
        );
        const jobs: Job[] = [];
        for (const row of result.rows) {
          const job = restore(row);
          if (!job.ok) return job;
          jobs.push(job.value);
        }
        return ok(jobs);
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }
}
