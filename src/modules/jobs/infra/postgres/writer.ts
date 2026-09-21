import {
  err,
  failure,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { assertEventWork } from '../../../../shared/events/index.js';
import { enqueue } from '../../../../shared/events/postgres/index.js';
import { map, type TransactionDatabase } from '../../../../shared/postgres/index.js';
import type { JobCommit, JobWriter } from '../../app/index.js';

export class PostgresJobWriter implements JobWriter {
  constructor(private readonly database: TransactionDatabase) {}

  commit(input: JobCommit): Promise<Result<void, Failure>> {
    return this.database.transaction(async (transaction) => {
      const provenance = assertEventWork(input.event, input.work);
      if (!provenance.ok) return provenance;
      try {
        if (input.mode === 'create') {
          await transaction.query(
            `INSERT INTO public.signals_jobs_jobs
              (id,organization_id,kind,subject_type,subject_id,status,attempts,max_attempts,created_at,updated_at,started_at,finished_at,failure_code)
             VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [
              input.job.id,
              input.job.organizationId,
              input.job.kind,
              input.job.subject?.type ?? null,
              input.job.subject?.id ?? null,
              input.job.status,
              input.job.attempts,
              input.job.maxAttempts,
              input.job.createdAt,
              input.job.updatedAt,
              input.job.startedAt,
              input.job.finishedAt,
              input.job.failureCode,
            ],
          );
        } else {
          const updated = await transaction.query(
            `UPDATE public.signals_jobs_jobs
                SET kind=$2,
                    subject_type=$3,
                    subject_id=$4::uuid,
                    status=$5,
                    attempts=$6,
                    max_attempts=$7,
                    updated_at=$8,
                    started_at=$9,
                    finished_at=$10,
                    failure_code=$11
              WHERE id=$1::uuid
                AND organization_id=$12::uuid`,
            [
              input.job.id,
              input.job.kind,
              input.job.subject?.type ?? null,
              input.job.subject?.id ?? null,
              input.job.status,
              input.job.attempts,
              input.job.maxAttempts,
              input.job.updatedAt,
              input.job.startedAt,
              input.job.finishedAt,
              input.job.failureCode,
              input.job.organizationId,
            ],
          );
          if (updated.rowCount !== 1) {
            return err(failure('not_found', 'job was not found', { type: 'job.not_found' }));
          }
        }
        return enqueue(transaction, input.event);
      } catch (cause) {
        return err(map(cause));
      }
    }, input.signal);
  }
}
