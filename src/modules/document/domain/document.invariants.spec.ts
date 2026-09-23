import { describe, expect, it } from 'vitest';
import { parse, type ID } from '../../../shared/id/index.js';
import {
  DOCUMENT_STATUSES,
  Document,
  type CreateDocumentInput,
  type RestoreDocumentInput,
} from './document.js';

function id(value: string): ID {
  const result = parse(value);
  if (!result.ok) throw new Error(`fixture ID ${value} is invalid`);
  return result.value;
}

const documentId = id('01900000-0000-7000-8000-000000000011');
const organizationId = id('01900000-0000-7000-8000-000000000001');
const runA = id('00000000-0000-7000-8000-00000000000a');
const runB = id('00000000-0000-7000-8000-00000000000b');

const at = (hour: number) =>
  new Date(`2026-09-20T${String(hour).padStart(2, '0')}:00:00.000Z`);
const createdAt = at(0);

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function failureType(
  result: { ok: true } | { ok: false; error: { kind: string; type?: string } },
): string | undefined {
  expect(result.ok).toBe(false);
  if (result.ok) return undefined;
  expect(result.error.kind).toBe('invalid');
  return result.error.type;
}

function create(overrides: Partial<CreateDocumentInput> = {}) {
  return Document.create({
    id: documentId,
    organizationId,
    name: 'Contract.pdf',
    createdAt,
    ...overrides,
  });
}

function restoreInput(
  overrides: Partial<RestoreDocumentInput> = {},
): RestoreDocumentInput {
  return {
    id: documentId,
    organizationId,
    name: 'Contract.pdf',
    storageKey: 'documents/contract.pdf',
    status: 'active',
    processingFailureCode: null,
    processingRun: null,
    processingAttempt: 0,
    createdAt,
    updatedAt: at(1),
    archivedAt: null,
    version: 3,
    ...overrides,
  };
}

const restore = (overrides: Partial<RestoreDocumentInput> = {}) =>
  Document.restore(restoreInput(overrides));

const active = () => unwrap(create());
const processing = (run: ID = runA) =>
  unwrap(active().beginProcessing(at(1), run));

describe('Document invariants', () => {
  it('lists every lifecycle status', () => {
    expect([...DOCUMENT_STATUSES]).toEqual([
      'active',
      'processing',
      'processed',
      'processing_failed',
      'archived',
    ]);
    expect(Object.isFrozen(DOCUMENT_STATUSES)).toBe(true);
  });

  describe('create', () => {
    it('starts unsaved, active and without processing history', () => {
      const document = active();
      expect(document.id).toBe(documentId);
      expect(document.organizationId).toBe(organizationId);
      expect(document.version).toBe(0);
      expect(document.status).toBe('active');
      expect(document.processingFailureCode).toBeNull();
      expect(document.processingRun).toBeNull();
      expect(document.processingAttempt).toBe(0);
      expect(document.createdAt).toEqual(createdAt);
      expect(document.updatedAt).toEqual(createdAt);
      expect(document.archivedAt).toBeNull();
    });

    it('rejects a non-string name', () => {
      expect(failureType(create({ name: 42 }))).toBe('document.invalid_name');
      expect(failureType(create({ name: undefined }))).toBe(
        'document.invalid_name',
      );
    });

    it('bounds the trimmed name to 1..200 characters', () => {
      expect(unwrap(create({ name: 'a' })).name).toBe('a');
      expect(unwrap(create({ name: 'a'.repeat(200) })).name).toBe(
        'a'.repeat(200),
      );
      expect(unwrap(create({ name: `  ${'a'.repeat(200)}  ` })).name).toBe(
        'a'.repeat(200),
      );
      expect(failureType(create({ name: 'a'.repeat(201) }))).toBe(
        'document.invalid_name',
      );
      expect(failureType(create({ name: '' }))).toBe('document.invalid_name');
    });

    it('treats null storage key as absent and rejects non-strings', () => {
      expect(unwrap(create({ storageKey: null })).storageKey).toBeNull();
      expect(failureType(create({ storageKey: 7 }))).toBe(
        'document.invalid_storage_key',
      );
    });

    it('bounds the trimmed storage key to 1..512 characters', () => {
      expect(unwrap(create({ storageKey: '  k  ' })).storageKey).toBe('k');
      expect(unwrap(create({ storageKey: 'k'.repeat(512) })).storageKey).toBe(
        'k'.repeat(512),
      );
      expect(failureType(create({ storageKey: 'k'.repeat(513) }))).toBe(
        'document.invalid_storage_key',
      );
      expect(failureType(create({ storageKey: '' }))).toBe(
        'document.invalid_storage_key',
      );
    });

    it('validates the name before the storage key', () => {
      expect(failureType(create({ name: '', storageKey: '' }))).toBe(
        'document.invalid_name',
      );
    });

    it('rejects an invalid creation time', () => {
      expect(failureType(create({ createdAt: new Date(Number.NaN) }))).toBe(
        'document.invalid_created_at',
      );
      expect(
        failureType(
          create({ createdAt: '2026-09-20' as unknown as Date }),
        ),
      ).toBe('document.invalid_created_at');
    });

    it('copies the creation time instead of holding the caller date', () => {
      const input = new Date(createdAt.getTime());
      const document = unwrap(create({ createdAt: input }));
      input.setTime(0);
      expect(document.createdAt).toEqual(createdAt);
      expect(document.updatedAt).toEqual(createdAt);
    });
  });

  describe('restore', () => {
    it('restores every stored field', () => {
      const document = unwrap(
        restore({
          status: 'processing_failed',
          processingFailureCode: 'provider.timeout',
          processingRun: runA,
          processingAttempt: 2,
        }),
      );
      expect(document.id).toBe(documentId);
      expect(document.organizationId).toBe(organizationId);
      expect(document.name).toBe('Contract.pdf');
      expect(document.storageKey).toBe('documents/contract.pdf');
      expect(document.status).toBe('processing_failed');
      expect(document.processingFailureCode).toBe('provider.timeout');
      expect(document.processingRun).toBe(runA);
      expect(document.processingAttempt).toBe(2);
      expect(document.createdAt).toEqual(createdAt);
      expect(document.updatedAt).toEqual(at(1));
      expect(document.archivedAt).toBeNull();
      expect(document.version).toBe(3);
    });

    it('restores an archived document with its archive time', () => {
      const document = unwrap(
        restore({ status: 'archived', archivedAt: at(1) }),
      );
      expect(document.status).toBe('archived');
      expect(document.archivedAt).toEqual(at(1));
    });

    it('validates name, storage key and failure code', () => {
      expect(failureType(restore({ name: ' ' }))).toBe('document.invalid_name');
      expect(failureType(restore({ storageKey: 5 }))).toBe(
        'document.invalid_storage_key',
      );
      expect(
        failureType(
          restore({
            status: 'processing_failed',
            processingFailureCode: 'Bad code',
          }),
        ),
      ).toBe('document.invalid_processing_failure_code');
    });

    it('accepts failure codes of the documented shape only', () => {
      const withCode = (code: string) =>
        restore({ status: 'processing_failed', processingFailureCode: code });
      expect(unwrap(withCode('a')).processingFailureCode).toBe('a');
      expect(unwrap(withCode(`a${'b'.repeat(127)}`)).processingFailureCode).toBe(
        `a${'b'.repeat(127)}`,
      );
      expect(unwrap(withCode('a0_.-z')).processingFailureCode).toBe('a0_.-z');
      for (const code of [
        `a${'b'.repeat(128)}`,
        '0abc',
        'Abc',
        '',
        ' abc',
        'abc ',
        'abc!',
        'x!abc',
      ]) {
        expect(failureType(withCode(code))).toBe(
          'document.invalid_processing_failure_code',
        );
      }
      expect(
        failureType(
          restore({
            status: 'processing_failed',
            processingFailureCode: 12 as unknown as string,
          }),
        ),
      ).toBe('document.invalid_processing_failure_code');
    });

    it.each([
      ['an unknown status', { status: 'deleted' as never }],
      ['an invalid creation time', { createdAt: new Date(Number.NaN) }],
      ['an invalid update time', { updatedAt: new Date(Number.NaN) }],
      [
        'an invalid archive time',
        { status: 'archived' as const, archivedAt: new Date(Number.NaN) },
      ],
      ['an unsaved version', { version: 0 }],
      ['a fractional attempt', { processingAttempt: 1.5 }],
      ['a negative attempt', { processingAttempt: -1 }],
    ])('rejects %s as invalid state', (_label, overrides) => {
      expect(failureType(restore(overrides))).toBe('document.invalid_state');
    });

    it('rejects an update time before creation but allows equal times', () => {
      expect(failureType(restore({ updatedAt: at(0), createdAt: at(1) }))).toBe(
        'document.non_monotonic_time',
      );
      expect(unwrap(restore({ updatedAt: createdAt })).updatedAt).toEqual(
        createdAt,
      );
    });

    it.each([
      ['active', { status: 'active' as const, archivedAt: at(1) }],
      ['processing', { status: 'processing' as const, archivedAt: at(1) }],
      ['processed', { status: 'processed' as const, archivedAt: at(1) }],
      [
        'active',
        { status: 'active' as const, processingFailureCode: 'x.fail' },
      ],
      [
        'processing',
        { status: 'processing' as const, processingFailureCode: 'x.fail' },
      ],
      [
        'processed',
        { status: 'processed' as const, processingFailureCode: 'x.fail' },
      ],
      [
        'processing_failed',
        {
          status: 'processing_failed' as const,
          processingFailureCode: 'x.fail',
          archivedAt: at(1),
        },
      ],
      [
        'processing_failed',
        { status: 'processing_failed' as const, processingFailureCode: null },
      ],
      ['archived', { status: 'archived' as const, archivedAt: null }],
    ])('rejects an inconsistent %s state', (_label, overrides) => {
      expect(failureType(restore(overrides))).toBe('document.invalid_state');
    });

    it.each(['active', 'processing', 'processed'] as const)(
      'accepts a consistent %s state',
      (status) => {
        expect(unwrap(restore({ status })).status).toBe(status);
      },
    );

    it('accepts an archived document that kept its failure code', () => {
      const document = unwrap(
        restore({
          status: 'archived',
          archivedAt: at(1),
          processingFailureCode: 'x.fail',
        }),
      );
      expect(document.processingFailureCode).toBe('x.fail');
    });

    it('copies input dates', () => {
      const created = at(0);
      const updated = at(1);
      const archived = at(1);
      const document = unwrap(
        restore({
          status: 'archived',
          createdAt: created,
          updatedAt: updated,
          archivedAt: archived,
        }),
      );
      created.setTime(0);
      updated.setTime(0);
      archived.setTime(0);
      expect(document.createdAt).toEqual(at(0));
      expect(document.updatedAt).toEqual(at(1));
      expect(document.archivedAt).toEqual(at(1));
    });
  });

  describe('immutability', () => {
    it('returns date copies from getters', () => {
      const document = unwrap(active().archive(at(2)));
      document.createdAt.setTime(0);
      document.updatedAt.setTime(0);
      document.archivedAt?.setTime(0);
      expect(document.createdAt).toEqual(createdAt);
      expect(document.updatedAt).toEqual(at(2));
      expect(document.archivedAt).toEqual(at(2));
    });

    it('marks a saved copy with the next version and leaves the original', () => {
      const document = unwrap(restore({ version: 3 }));
      const saved = document.saved();
      expect(saved).not.toBe(document);
      expect(saved.version).toBe(4);
      expect(document.version).toBe(3);
      expect(saved.name).toBe(document.name);
      expect(saved.status).toBe(document.status);
      expect(saved.updatedAt).toEqual(document.updatedAt);
      expect(active().saved().version).toBe(1);
    });
  });

  describe('archive', () => {
    it('rejects an invalid archive time', () => {
      expect(failureType(active().archive(new Date(Number.NaN)))).toBe(
        'document.invalid_archived_at',
      );
    });

    it('rejects moving backwards but allows the same instant', () => {
      const document = unwrap(restore({ updatedAt: at(2) }));
      expect(
        failureType(document.archive(new Date(at(2).getTime() - 1))),
      ).toBe('document.non_monotonic_time');
      const archived = unwrap(document.archive(at(2)));
      expect(archived.archivedAt).toEqual(at(2));
    });

    it('checks time before the archived state', () => {
      const archived = unwrap(active().archive(at(2)));
      expect(failureType(archived.archive(at(1)))).toBe(
        'document.non_monotonic_time',
      );
      expect(failureType(archived.archive(new Date(Number.NaN)))).toBe(
        'document.invalid_archived_at',
      );
    });

    it('archives a document in any non-archived status and keeps its history', () => {
      const failed = unwrap(
        processing().applyProcessingOutcome(at(2), {
          run: runA,
          attempt: 1,
          result: 'failed',
          failureCode: 'provider.timeout',
        }),
      );
      const archived = unwrap(failed.archive(at(3)));
      expect(archived.status).toBe('archived');
      expect(archived.processingFailureCode).toBe('provider.timeout');
      expect(archived.processingRun).toBe(runA);
      expect(archived.processingAttempt).toBe(1);
      expect(failed.status).toBe('processing_failed');
      expect(failed.archivedAt).toBeNull();
    });

    it('does not share the archive date with the caller', () => {
      const when = at(2);
      const archived = unwrap(active().archive(when));
      when.setTime(0);
      expect(archived.archivedAt).toEqual(at(2));
      expect(archived.updatedAt).toEqual(at(2));
    });
  });

  describe('beginProcessing', () => {
    it('moves an active document into processing for the run', () => {
      const document = active();
      const started = unwrap(document.beginProcessing(at(1), runA));
      expect(started).not.toBe(document);
      expect(started.status).toBe('processing');
      expect(started.processingRun).toBe(runA);
      expect(started.processingAttempt).toBe(0);
      expect(started.processingFailureCode).toBeNull();
      expect(started.updatedAt).toEqual(at(1));
      expect(document.status).toBe('active');
      expect(document.processingRun).toBeNull();
    });

    it('rejects an invalid start time', () => {
      expect(
        failureType(active().beginProcessing(new Date(Number.NaN), runA)),
      ).toBe('document.invalid_processing_started_at');
    });

    it('rejects moving backwards but allows the same instant', () => {
      const document = unwrap(restore({ updatedAt: at(2) }));
      expect(
        failureType(
          document.beginProcessing(new Date(at(2).getTime() - 1), runA),
        ),
      ).toBe('document.non_monotonic_time');
      expect(unwrap(document.beginProcessing(at(2), runA)).status).toBe(
        'processing',
      );
    });

    it('refuses archived and processed documents', () => {
      const archived = unwrap(active().archive(at(1)));
      expect(failureType(archived.beginProcessing(at(2), runA))).toBe(
        'document.archived',
      );
      const processed = unwrap(
        processing().applyProcessingOutcome(at(2), {
          run: runA,
          attempt: 0,
          result: 'succeeded',
        }),
      );
      expect(failureType(processed.beginProcessing(at(3), runA))).toBe(
        'document.already_processed',
      );
      expect(failureType(processed.beginProcessing(at(3), runB))).toBe(
        'document.already_processed',
      );
    });

    it('replaces a run in progress and resets its attempt', () => {
      const advanced = unwrap(
        processing().applyProcessingOutcome(at(2), {
          run: runA,
          attempt: 3,
          result: 'retrying',
        }),
      );
      expect(advanced.processingAttempt).toBe(3);
      const replaced = unwrap(advanced.beginProcessing(at(3), runB));
      expect(replaced).not.toBe(advanced);
      expect(replaced.status).toBe('processing');
      expect(replaced.processingRun).toBe(runB);
      expect(replaced.processingAttempt).toBe(0);
      expect(replaced.updatedAt).toEqual(at(3));
    });

    it('restarts a failed run even with the same run ID and clears the failure', () => {
      const failed = unwrap(
        processing().applyProcessingOutcome(at(2), {
          run: runA,
          attempt: 2,
          result: 'failed',
          failureCode: 'provider.timeout',
        }),
      );
      const restarted = unwrap(failed.beginProcessing(at(3), runA));
      expect(restarted).not.toBe(failed);
      expect(restarted.status).toBe('processing');
      expect(restarted.processingFailureCode).toBeNull();
      expect(restarted.processingAttempt).toBe(0);
      expect(restarted.updatedAt).toEqual(at(3));
    });

    it('does not share the start date with the caller', () => {
      const when = at(1);
      const started = unwrap(active().beginProcessing(when, runA));
      when.setTime(0);
      expect(started.updatedAt).toEqual(at(1));
    });
  });

  describe('applyProcessingOutcome', () => {
    it('rejects an invalid outcome time before looking at state', () => {
      const archived = unwrap(active().archive(at(1)));
      for (const document of [processing(), archived]) {
        expect(
          failureType(
            document.applyProcessingOutcome(new Date(Number.NaN), {
              run: runA,
              attempt: 1,
              result: 'succeeded',
            }),
          ),
        ).toBe('document.invalid_processing_outcome');
      }
    });

    it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
      'rejects attempt %s',
      (attempt) => {
        expect(
          failureType(
            processing().applyProcessingOutcome(at(2), {
              run: runA,
              attempt,
              result: 'succeeded',
            }),
          ),
        ).toBe('document.invalid_processing_outcome');
      },
    );

    it('accepts attempt zero', () => {
      const done = unwrap(
        processing().applyProcessingOutcome(at(2), {
          run: runA,
          attempt: 0,
          result: 'succeeded',
        }),
      );
      expect(done.status).toBe('processed');
      expect(done.processingAttempt).toBe(0);
    });

    it('ignores outcomes for an active document', () => {
      const document = active();
      for (const result of ['succeeded', 'retrying', 'failed'] as const) {
        expect(
          unwrap(
            document.applyProcessingOutcome(at(2), {
              run: runA,
              attempt: 1,
              result,
              failureCode: 'x.fail',
            }),
          ),
        ).toBe(document);
      }
    });

    it('ignores outcomes once processed, even from a newer attempt', () => {
      const done = unwrap(
        processing().applyProcessingOutcome(at(2), {
          run: runA,
          attempt: 1,
          result: 'succeeded',
        }),
      );
      for (const result of ['succeeded', 'retrying', 'failed'] as const) {
        expect(
          unwrap(
            done.applyProcessingOutcome(at(3), {
              run: runA,
              attempt: 5,
              result,
              failureCode: 'x.fail',
            }),
          ),
        ).toBe(done);
      }
    });

    it('ignores outcomes of an archived document that was processing', () => {
      const archived = unwrap(
        restore({
          status: 'archived',
          archivedAt: at(1),
          processingRun: runA,
          processingAttempt: 0,
        }),
      );
      expect(
        unwrap(
          archived.applyProcessingOutcome(at(2), {
            run: runA,
            attempt: 1,
            result: 'failed',
            failureCode: 'x.fail',
          }),
        ),
      ).toBe(archived);
    });

    it('ignores outcomes of another run and stale failures without validating their code', () => {
      const started = processing();
      expect(
        unwrap(
          started.applyProcessingOutcome(at(2), {
            run: runB,
            attempt: 1,
            result: 'failed',
          }),
        ),
      ).toBe(started);
    });

    it('does not let a failed legacy document without a run adopt one', () => {
      const legacyFailed = unwrap(
        restore({
          status: 'processing_failed',
          processingFailureCode: 'x.fail',
          processingRun: null,
        }),
      );
      expect(
        unwrap(
          legacyFailed.applyProcessingOutcome(at(2), {
            run: runA,
            attempt: 1,
            result: 'succeeded',
          }),
        ),
      ).toBe(legacyFailed);
    });

    it('ignores an older attempt of the current run', () => {
      const advanced = unwrap(
        processing().applyProcessingOutcome(at(2), {
          run: runA,
          attempt: 2,
          result: 'retrying',
        }),
      );
      expect(
        unwrap(
          advanced.applyProcessingOutcome(at(3), {
            run: runA,
            attempt: 1,
            result: 'succeeded',
          }),
        ),
      ).toBe(advanced);
    });

    it('applies the same attempt when it finishes the run', () => {
      const advanced = unwrap(
        processing().applyProcessingOutcome(at(2), {
          run: runA,
          attempt: 2,
          result: 'retrying',
        }),
      );
      const done = unwrap(
        advanced.applyProcessingOutcome(at(3), {
          run: runA,
          attempt: 2,
          result: 'succeeded',
        }),
      );
      expect(done.status).toBe('processed');
    });

    it('never moves updatedAt backwards for a late outcome', () => {
      const started = unwrap(
        unwrap(restore({ updatedAt: at(5) })).beginProcessing(at(5), runA),
      );
      const done = unwrap(
        started.applyProcessingOutcome(at(3), {
          run: runA,
          attempt: 1,
          result: 'succeeded',
        }),
      );
      expect(done.status).toBe('processed');
      expect(done.updatedAt).toEqual(at(5));
      const later = unwrap(
        started.applyProcessingOutcome(at(7), {
          run: runA,
          attempt: 1,
          result: 'succeeded',
        }),
      );
      expect(later.updatedAt).toEqual(at(7));
    });

    it('does not share the outcome date with the caller', () => {
      const when = at(4);
      const done = unwrap(
        processing().applyProcessingOutcome(when, {
          run: runA,
          attempt: 1,
          result: 'succeeded',
        }),
      );
      when.setTime(0);
      expect(done.updatedAt).toEqual(at(4));
    });

    it('records a newer retrying attempt while processing', () => {
      const started = processing();
      const retrying = unwrap(
        started.applyProcessingOutcome(at(2), {
          run: runA,
          attempt: 1,
          result: 'retrying',
        }),
      );
      expect(retrying).not.toBe(started);
      expect(retrying.status).toBe('processing');
      expect(retrying.processingAttempt).toBe(1);
      expect(retrying.processingRun).toBe(runA);
      expect(retrying.updatedAt).toEqual(at(2));
      expect(started.processingAttempt).toBe(0);
    });

    it('ignores a retrying report for the current attempt', () => {
      const started = processing();
      expect(
        unwrap(
          started.applyProcessingOutcome(at(2), {
            run: runA,
            attempt: 0,
            result: 'retrying',
          }),
        ),
      ).toBe(started);
    });

    it('moves a failed document back to processing on retry and clears the failure', () => {
      const failed = unwrap(
        processing().applyProcessingOutcome(at(2), {
          run: runA,
          attempt: 1,
          result: 'failed',
          failureCode: 'provider.timeout',
        }),
      );
      const retrying = unwrap(
        failed.applyProcessingOutcome(at(3), {
          run: runA,
          attempt: 1,
          result: 'retrying',
        }),
      );
      expect(retrying).not.toBe(failed);
      expect(retrying.status).toBe('processing');
      expect(retrying.processingFailureCode).toBeNull();
      expect(retrying.processingAttempt).toBe(1);
      expect(retrying.updatedAt).toEqual(at(3));
    });

    it('a success after failure clears the failure code', () => {
      const failed = unwrap(
        processing().applyProcessingOutcome(at(2), {
          run: runA,
          attempt: 1,
          result: 'failed',
          failureCode: 'provider.timeout',
        }),
      );
      const done = unwrap(
        failed.applyProcessingOutcome(at(3), {
          run: runA,
          attempt: 2,
          result: 'succeeded',
        }),
      );
      expect(done.status).toBe('processed');
      expect(done.processingFailureCode).toBeNull();
      expect(done.updatedAt).toEqual(at(3));
    });

    it('requires a valid failure code on a failed outcome', () => {
      for (const failureCode of [undefined, null, 'Not valid', 42]) {
        expect(
          failureType(
            processing().applyProcessingOutcome(at(2), {
              run: runA,
              attempt: 1,
              result: 'failed',
              failureCode,
            }),
          ),
        ).toBe('document.invalid_processing_failure_code');
      }
    });

    it('records a failure with its code, run and attempt', () => {
      const failed = unwrap(
        processing().applyProcessingOutcome(at(2), {
          run: runA,
          attempt: 1,
          result: 'failed',
          failureCode: 'provider.timeout',
        }),
      );
      expect(failed.status).toBe('processing_failed');
      expect(failed.processingFailureCode).toBe('provider.timeout');
      expect(failed.processingRun).toBe(runA);
      expect(failed.processingAttempt).toBe(1);
      expect(failed.updatedAt).toEqual(at(2));
    });

    it('replaces the failure when a newer attempt of the run fails', () => {
      const failed = unwrap(
        processing().applyProcessingOutcome(at(2), {
          run: runA,
          attempt: 1,
          result: 'failed',
          failureCode: 'provider.timeout',
        }),
      );
      const failedAgain = unwrap(
        failed.applyProcessingOutcome(at(3), {
          run: runA,
          attempt: 2,
          result: 'failed',
          failureCode: 'provider.rejected',
        }),
      );
      expect(failedAgain).not.toBe(failed);
      expect(failedAgain.processingFailureCode).toBe('provider.rejected');
      expect(failedAgain.processingAttempt).toBe(2);
    });

    it('validates the failure code of a redelivered failure', () => {
      const failed = unwrap(
        processing().applyProcessingOutcome(at(2), {
          run: runA,
          attempt: 1,
          result: 'failed',
          failureCode: 'provider.timeout',
        }),
      );
      expect(
        failureType(
          failed.applyProcessingOutcome(at(3), {
            run: runA,
            attempt: 1,
            result: 'failed',
          }),
        ),
      ).toBe('document.invalid_processing_failure_code');
    });

    it('fails the current attempt when it is the first report of that attempt', () => {
      const failed = unwrap(
        processing().applyProcessingOutcome(at(2), {
          run: runA,
          attempt: 0,
          result: 'failed',
          failureCode: 'provider.timeout',
        }),
      );
      expect(failed.status).toBe('processing_failed');
      expect(failed.processingFailureCode).toBe('provider.timeout');
    });

    it('rejects a failure code that is not a string even if it stringifies validly', () => {
      expect(
        failureType(
          processing().applyProcessingOutcome(at(2), {
            run: runA,
            attempt: 1,
            result: 'failed',
            failureCode: ['provider.timeout'],
          }),
        ),
      ).toBe('document.invalid_processing_failure_code');
    });

    it('ignores outcomes for an active document even when it remembers the run', () => {
      const document = unwrap(
        restore({ status: 'active', processingRun: runA, processingAttempt: 0 }),
      );
      expect(
        unwrap(
          document.applyProcessingOutcome(at(2), {
            run: runA,
            attempt: 1,
            result: 'succeeded',
          }),
        ),
      ).toBe(document);
    });

    it('lets a legacy processing document adopt the first run on retry', () => {
      const legacy = unwrap(
        restore({ status: 'processing', processingRun: null }),
      );
      const retrying = unwrap(
        legacy.applyProcessingOutcome(at(2), {
          run: runB,
          attempt: 1,
          result: 'retrying',
        }),
      );
      expect(retrying.processingRun).toBe(runB);
      expect(retrying.processingAttempt).toBe(1);
    });
  });
});
