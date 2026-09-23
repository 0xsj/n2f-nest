import { ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import { keysetPage, type After } from '../../../../shared/pagination/index.js';
import type { AuditEntryReader, AuditEntryWriter, AuditWriteResult } from '../../app/ports/index.js';
import type { AuditEntry } from '../../domain/index.js';
import { InMemoryAuditStore } from './store.js';

export class InMemoryAuditEntryWriter implements AuditEntryWriter {
  constructor(private readonly store: InMemoryAuditStore) {}

  async record(entry: AuditEntry): Promise<Result<AuditWriteResult, Failure>> {
    const existing = this.store.findByEventId(entry.eventId);
    if (existing) return ok({ entry: existing, created: false });
    this.store.add(entry);
    return ok({ entry, created: true });
  }
}

export class InMemoryAuditEntryReader implements AuditEntryReader {
  constructor(private readonly store: InMemoryAuditStore) {}

  async list(): Promise<Result<readonly AuditEntry[], Failure>> {
    return ok(this.store.list().slice(-1000));
  }

  async listForTenant(
    tenant: ID,
    page: Readonly<{ limit: number; after?: After }>,
  ): Promise<Result<readonly AuditEntry[], Failure>> {
    return ok(
      keysetPage(
        this.store.list().filter((entry) => entry.tenant === tenant),
        (entry) => ({ at: entry.recordedAt, id: entry.id }),
        page,
      ),
    );
  }
}
