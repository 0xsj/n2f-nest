import { Injectable } from '@nestjs/common';
import { ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { DocumentReader } from '../../app/index.js';
import type { Document } from '../../domain/index.js';
import { InMemoryDocumentStore } from './store.js';

@Injectable()
export class InMemoryDocumentReader implements DocumentReader {
  constructor(private readonly store: InMemoryDocumentStore) {}

  async findById(id: ID): Promise<Result<Document | null, Failure>> {
    return ok(this.store.documentById(id) ?? null);
  }

  async listForOrganization(
    organizationId: ID,
  ): Promise<Result<readonly Document[], Failure>> {
    return ok(this.store.documentsForOrganization(organizationId));
  }
}
