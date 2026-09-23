import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import type { After } from '../../../../shared/pagination/index.js';
import { map, type TransactionDatabase } from '../../../../shared/postgres/index.js';
import type { DocumentReader } from '../../app/index.js';
import { Document } from '../../domain/index.js';

type DocumentRow = {
  document_id: string;
  organization_id: string;
  name: string;
  storage_key: string | null;
  status: string;
  processing_failure_code: string | null;
  processing_run: string | null;
  processing_attempt: number;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  version: number;
};

function storedId(value: unknown, type: string): Result<ID, Failure> {
  if (typeof value !== 'string') {
    return err(failure('internal', 'stored document ID is invalid', { type }));
  }
  return parse(value);
}

function restore(row: DocumentRow): Result<Document, Failure> {
  const documentId = storedId(row.document_id, 'document.persistence_invalid');
  if (!documentId.ok) return documentId;
  const organizationId = storedId(
    row.organization_id,
    'document.persistence_invalid',
  );
  if (!organizationId.ok) return organizationId;
  const processingRun =
    row.processing_run === null
      ? null
      : storedId(row.processing_run, 'document.persistence_invalid');
  if (processingRun !== null && !processingRun.ok) return processingRun;
  return Document.restore({
    id: documentId.value,
    organizationId: organizationId.value,
    name: row.name,
    storageKey: row.storage_key,
    status: row.status as Document['status'],
    processingFailureCode: row.processing_failure_code,
    processingRun: processingRun === null ? null : processingRun.value,
    processingAttempt: row.processing_attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    version: row.version,
  });
}

export class PostgresDocumentReader implements DocumentReader {
  constructor(private readonly database: TransactionDatabase) {}

  findById(
    id: ID,
    signal?: AbortSignal,
  ): Promise<Result<Document | null, Failure>> {
    return this.database.transaction(async (transaction) => {
      try {
        const result = await transaction.query<DocumentRow>(
          `SELECT id AS document_id,
                  organization_id,
                  name,
                  storage_key,
                  status,
                  processing_failure_code,
                  created_at,
                  updated_at,
                  archived_at,
                  processing_run::text,
                  processing_attempt,
                  version
             FROM public.n2f_document_documents
            WHERE id=$1::uuid`,
          [id],
        );
        const row = result.rows[0];
        return row ? restore(row) : ok(null);
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }

  listForOrganization(
    organizationId: ID,
    page: Readonly<{ limit: number; after?: After }>,
    signal?: AbortSignal,
  ): Promise<Result<readonly Document[], Failure>> {
    return this.database.transaction(async (transaction) => {
      try {
        const result = await transaction.query<DocumentRow>(
          `SELECT id AS document_id,
                  organization_id,
                  name,
                  storage_key,
                  status,
                  processing_failure_code,
                  created_at,
                  updated_at,
                  archived_at,
                  processing_run::text,
                  processing_attempt,
                  version
             FROM public.n2f_document_documents
            WHERE organization_id=$1::uuid
              AND ($2::timestamptz IS NULL OR (created_at,id) > ($2::timestamptz,$3::uuid))
            ORDER BY created_at,id
            LIMIT $4`,
          [organizationId, page.after?.at ?? null, page.after?.id ?? null, page.limit + 1],
        );
        const documents: Document[] = [];
        for (const row of result.rows) {
          const document = restore(row);
          if (!document.ok) return document;
          documents.push(document.value);
        }
        return ok(documents);
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }
}
