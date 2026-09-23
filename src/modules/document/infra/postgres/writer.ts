import {
  err,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { assertEventWork } from '../../../../shared/events/index.js';
import { enqueue } from '../../../../shared/events/postgres/index.js';
import {
  map,
  missingOrStale,
  violatedUnique,
  type TransactionDatabase,
} from '../../../../shared/postgres/index.js';
import {
  CONSTRAINTS,
  documentExists,
  documentNotFound,
  staleWrite,
} from '../failures.js';
import type { DocumentCommit, DocumentWriter } from '../../app/index.js';

export class PostgresDocumentWriter implements DocumentWriter {
  constructor(private readonly database: TransactionDatabase) {}

  commit(input: DocumentCommit): Promise<Result<void, Failure>> {
    return this.database.transaction(async (transaction) => {
      const provenance = assertEventWork(input.event, input.work);
      if (!provenance.ok) return provenance;

      try {
        if (input.mode === 'create') {
          await transaction.query(
            `INSERT INTO public.n2f_document_documents
              (id,organization_id,name,storage_key,status,processing_failure_code,created_at,updated_at,archived_at)
             VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9)`,
            [
              input.document.id,
              input.document.organizationId,
              input.document.name,
              input.document.storageKey,
              input.document.status,
              input.document.processingFailureCode,
              input.document.createdAt,
              input.document.updatedAt,
              input.document.archivedAt,
            ],
          );
        } else {
          const updated = await transaction.query(
            `UPDATE public.n2f_document_documents
                SET name=$2,
                    storage_key=$3,
                    status=$4,
                    processing_failure_code=$5,
                    updated_at=$6,
                    archived_at=$7,
                    processing_run=$10::uuid,
                    processing_attempt=$11,
                    version=version+1
              WHERE id=$1::uuid
                AND organization_id=$8::uuid
                AND version=$9`,
            [
              input.document.id,
              input.document.name,
              input.document.storageKey,
              input.document.status,
              input.document.processingFailureCode,
              input.document.updatedAt,
              input.document.archivedAt,
              input.document.organizationId,
              input.document.version,
              input.document.processingRun,
              input.document.processingAttempt,
            ],
          );
          if (updated.rowCount !== 1) {
            return err(
              (await missingOrStale(
                transaction,
                'public.n2f_document_documents',
                input.document.id,
              )) === 'missing'
                ? documentNotFound()
                : staleWrite(),
            );
          }
        }

        return await enqueue(transaction, input.event);
      } catch (cause) {
        return err(
          violatedUnique(cause) === CONSTRAINTS.documentPkey
            ? documentExists()
            : map(cause),
        );
      }
    }, input.signal);
  }
}
