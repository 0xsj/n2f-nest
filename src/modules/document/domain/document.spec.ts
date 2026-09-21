import { describe, expect, it } from 'vitest';
import { parse } from '../../../shared/id/index.js';
import { Document } from './document.js';

const documentId = parse('01900000-0000-7000-8000-000000000011');
const organizationId = parse('01900000-0000-7000-8000-000000000001');
if (!documentId.ok || !organizationId.ok) throw new Error('Document fixture IDs are invalid');

const createdAt = new Date('2026-09-20T00:00:00.000Z');

describe('Document', () => {
  it('creates an active document with normalized metadata', () => {
    const result = Document.create({
      id: documentId.value,
      organizationId: organizationId.value,
      name: '  Contract.pdf  ',
      storageKey: 'documents/contract.pdf',
      createdAt,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('Contract.pdf');
      expect(result.value.storageKey).toBe('documents/contract.pdf');
      expect(result.value.status).toBe('active');
      expect(result.value.archivedAt).toBeNull();
    }
  });

  it('allows a document record without storage metadata', () => {
    const result = Document.create({
      id: documentId.value,
      organizationId: organizationId.value,
      name: 'Unattached record',
      createdAt,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.storageKey).toBeNull();
  });

  it('rejects invalid names and storage keys at the domain boundary', () => {
    const invalidName = Document.create({
      id: documentId.value,
      organizationId: organizationId.value,
      name: '   ',
      createdAt,
    });
    const invalidStorageKey = Document.create({
      id: documentId.value,
      organizationId: organizationId.value,
      name: 'Contract.pdf',
      storageKey: '   ',
      createdAt,
    });

    expect(invalidName.ok).toBe(false);
    if (!invalidName.ok) expect(invalidName.error.type).toBe('document.invalid_name');
    expect(invalidStorageKey.ok).toBe(false);
    if (!invalidStorageKey.ok) {
      expect(invalidStorageKey.error.type).toBe('document.invalid_storage_key');
    }
  });

  it('archives immutably and prevents archiving twice', () => {
    const active = Document.create({
      id: documentId.value,
      organizationId: organizationId.value,
      name: 'Contract.pdf',
      createdAt,
    });
    if (!active.ok) throw new Error(active.error.message);

    const archivedAt = new Date('2026-09-20T01:00:00.000Z');
    const archived = active.value.archive(archivedAt);
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;

    expect(active.value.status).toBe('active');
    expect(archived.value.status).toBe('archived');
    expect(archived.value.archivedAt).toEqual(archivedAt);
    expect(archived.value.updatedAt).toEqual(archivedAt);

    const archivedAgain = archived.value.archive(new Date('2026-09-20T02:00:00.000Z'));
    expect(archivedAgain.ok).toBe(false);
    if (!archivedAgain.ok) {
      expect(archivedAgain.error.type).toBe('document.already_archived');
    }
  });

  it('models processing as an immutable document lifecycle', () => {
    const active = Document.create({
      id: documentId.value,
      organizationId: organizationId.value,
      name: 'Contract.pdf',
      createdAt,
    });
    if (!active.ok) throw new Error(active.error.message);

    const processing = active.value.beginProcessing(new Date('2026-09-20T01:00:00.000Z'));
    expect(processing.ok).toBe(true);
    if (!processing.ok) return;
    expect(active.value.status).toBe('active');
    expect(processing.value.status).toBe('processing');

    const failed = processing.value.markProcessingFailed(
      new Date('2026-09-20T02:00:00.000Z'),
      'provider.timeout',
    );
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value.status).toBe('processing_failed');
    expect(failed.value.processingFailureCode).toBe('provider.timeout');

    const retried = failed.value.beginProcessing(new Date('2026-09-20T03:00:00.000Z'));
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    const completed = retried.value.markProcessed(new Date('2026-09-20T04:00:00.000Z'));
    expect(completed.ok).toBe(true);
    if (completed.ok) {
      expect(completed.value.status).toBe('processed');
      expect(completed.value.processingFailureCode).toBeNull();
    }
  });
});
