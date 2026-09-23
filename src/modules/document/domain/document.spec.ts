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

  describe('processing runs', () => {
    const at = (hour: number) => new Date(`2026-09-20T${String(hour).padStart(2, '0')}:00:00.000Z`);
    const parsedA = parse('00000000-0000-7000-8000-00000000000a');
    const parsedB = parse('00000000-0000-7000-8000-00000000000b');
    if (!parsedA.ok || !parsedB.ok) throw new Error('run IDs invalid');
    const runA = { value: parsedA.value };
    const runB = { value: parsedB.value };
    if (!documentId.ok || !organizationId.ok) throw new Error('fixture IDs invalid');
    const ids = { document: documentId.value, organization: organizationId.value };

    function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    }
    function processing(run = runA.value) {
      const active = unwrap(
        Document.create({
          id: ids.document,
          organizationId: ids.organization,
          name: 'Contract.pdf',
          createdAt,
        }),
      );
      return unwrap(active.beginProcessing(at(1), run));
    }
    const outcome = (
      document: Document,
      hour: number,
      result: 'retrying' | 'succeeded' | 'failed',
      attempt: number,
      run = runA.value,
      failureCode?: string,
    ) => unwrap(document.applyProcessingOutcome(at(hour), { run, attempt, result, failureCode }));

    it('follows a run through failure, retry and completion', () => {
      const failed = outcome(processing(), 2, 'failed', 1, runA.value, 'provider.timeout');
      expect(failed.status).toBe('processing_failed');
      expect(failed.processingFailureCode).toBe('provider.timeout');
      const retrying = outcome(failed, 3, 'retrying', 1);
      expect(retrying.status).toBe('processing');
      const done = outcome(retrying, 4, 'succeeded', 2);
      expect(done.status).toBe('processed');
      expect(done.processingFailureCode).toBeNull();
      expect(done.processingRun).toBe(runA.value);
      expect(done.processingAttempt).toBe(2);
    });

    it('ignores a redelivered outcome', () => {
      const failed = outcome(processing(), 2, 'failed', 1, runA.value, 'provider.timeout');
      expect(outcome(failed, 3, 'failed', 1, runA.value, 'provider.timeout')).toBe(failed);
      const done = outcome(processing(), 2, 'succeeded', 1);
      expect(outcome(done, 3, 'succeeded', 1)).toBe(done);
    });

    it('ignores an older attempt that arrives after a newer one', () => {
      const failed = outcome(processing(), 2, 'failed', 1, runA.value, 'provider.timeout');
      const done = outcome(failed, 3, 'succeeded', 2);
      expect(outcome(done, 4, 'retrying', 1)).toBe(done);
      expect(done.status).toBe('processed');
    });

    it('keeps the original failure when the failed job is canceled afterwards', () => {
      const failed = outcome(processing(), 2, 'failed', 1, runA.value, 'provider.timeout');
      const canceled = outcome(failed, 3, 'failed', 1, runA.value, 'job.canceled');
      expect(canceled).toBe(failed);
      expect(canceled.processingFailureCode).toBe('provider.timeout');
    });

    it('ignores outcomes of a run it no longer waits on', () => {
      const failed = outcome(processing(), 2, 'failed', 1, runA.value, 'job.canceled');
      const rerun = unwrap(failed.beginProcessing(at(3), runB.value));
      expect(rerun.processingRun).toBe(runB.value);
      expect(outcome(rerun, 4, 'succeeded', 1, runA.value)).toBe(rerun);
      expect(outcome(rerun, 5, 'succeeded', 1, runB.value).status).toBe('processed');
    });

    it('treats beginning the same run again as a no-op', () => {
      const started = processing();
      expect(unwrap(started.beginProcessing(at(2), runA.value))).toBe(started);
    });

    it('ignores every outcome once archived', () => {
      const archived = unwrap(processing().archive(at(2)));
      expect(outcome(archived, 3, 'succeeded', 1)).toBe(archived);
      expect(archived.status).toBe('archived');
    });

    it('lets a document processing before runs were recorded adopt the first run', () => {
      const legacy = unwrap(
        Document.restore({
          id: ids.document,
          organizationId: ids.organization,
          name: 'Contract.pdf',
          storageKey: null,
          status: 'processing',
          processingFailureCode: null,
          processingRun: null,
          processingAttempt: 0,
          createdAt,
          updatedAt: createdAt,
          archivedAt: null,
          version: 1,
        }),
      );
      const done = outcome(legacy, 2, 'succeeded', 1);
      expect(done.status).toBe('processed');
      expect(done.processingRun).toBe(runA.value);
    });
  });
});
