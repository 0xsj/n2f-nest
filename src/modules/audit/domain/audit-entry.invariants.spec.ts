import { describe, expect, it } from 'vitest';
import { causeOf } from '../../../shared/errors/index.js';
import { parse, type ID } from '../../../shared/id/index.js';
import {
  actor,
  anonymous,
  attribution,
  operation,
  reference,
  restoreWork,
  type WorkSnapshot,
} from '../../../shared/provenance/index.js';
import {
  AuditEntry,
  type RecordAuditEntryInput,
  type RestoreAuditEntryInput,
} from './audit-entry.js';

function id(value: string): ID {
  const result = parse(value);
  if (!result.ok) throw new Error(`fixture ID ${value} is invalid`);
  return result.value;
}

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

const entryId = id('00000000-0000-7000-8000-000000000001');
const eventId = id('00000000-0000-7000-8000-000000000002');
const subjectId = id('00000000-0000-7000-8000-000000000003');
const tenantId = id('00000000-0000-7000-8000-000000000004');
const workId = id('00000000-0000-7000-8000-000000000005');
const runId = id('00000000-0000-7000-8000-000000000006');
const sourceId = id('00000000-0000-7000-8000-000000000007');

const initiator = unwrap(actor('user', 'user-1'));
const onBehalfOf = unwrap(actor('service', 'svc-1'));

function snapshot(): WorkSnapshot {
  return {
    workId,
    correlationId: eventId,
    correlationSource: 'external',
    operation: unwrap(operation('document.process')),
    attribution: unwrap(
      attribution({ initiator, onBehalfOf, tenant: 'tenant-1' }),
    ),
    origin: 'replay',
    causation: unwrap(reference('event', eventId)),
    depth: 1,
    replay: { runId, source: unwrap(reference('event', sourceId)) },
  };
}

const richWork = unwrap(restoreWork(snapshot()));
const plainWork = unwrap(
  restoreWork({
    workId,
    correlationId: eventId,
    correlationSource: 'local',
    operation: unwrap(operation('identity.register')),
    attribution: unwrap(attribution({ initiator: anonymous() })),
    origin: 'request',
  }),
);

const occurredAt = new Date('2026-09-19T00:00:00.000Z');
const recordedAt = new Date('2026-09-19T00:00:01.000Z');

function record(overrides: Partial<RecordAuditEntryInput> = {}) {
  return AuditEntry.record({
    id: entryId,
    eventId,
    eventType: 'document.processed.v1',
    occurredAt,
    recordedAt,
    work: plainWork,
    subject: { kind: 'document', id: subjectId },
    tenant: tenantId,
    ...overrides,
  });
}

function restore(overrides: Partial<RestoreAuditEntryInput> = {}) {
  return AuditEntry.restore({
    id: entryId,
    eventId,
    eventType: 'document.processed.v1',
    occurredAt,
    recordedAt,
    work: snapshot(),
    subject: { kind: 'document', id: subjectId },
    tenant: tenantId,
    ...overrides,
  });
}

describe('AuditEntry invariants', () => {
  it('records identifiers, times and tenant', () => {
    const entry = unwrap(record());
    expect(entry.id).toBe(entryId);
    expect(entry.eventId).toBe(eventId);
    expect(entry.eventType).toBe('document.processed.v1');
    expect(entry.occurredAt).toEqual(occurredAt);
    expect(entry.recordedAt).toEqual(recordedAt);
    expect(entry.tenant).toBe(tenantId);
  });

  it('records a missing tenant and subject as null', () => {
    const entry = unwrap(
      record({ tenant: undefined as unknown as null, subject: null }),
    );
    expect(entry.tenant).toBeNull();
    expect(entry.subject).toBeNull();
    expect(unwrap(record({ tenant: null })).tenant).toBeNull();
  });

  describe('times', () => {
    it.each([
      ['occurredAt', { occurredAt: new Date(Number.NaN) }],
      ['recordedAt', { recordedAt: new Date(Number.NaN) }],
      ['a non-Date occurredAt', { occurredAt: '2026-09-19' as never }],
      ['a non-Date recordedAt', { recordedAt: 0 as never }],
    ])('rejects an invalid %s', (_label, overrides) => {
      expect(failureType(record(overrides))).toBe('audit.invalid_time');
    });

    it('checks times before the event type', () => {
      expect(
        failureType(
          record({ occurredAt: new Date(Number.NaN), eventType: 'bad' }),
        ),
      ).toBe('audit.invalid_time');
    });

    it('copies dates in and out', () => {
      const occurred = new Date(occurredAt.getTime());
      const recorded = new Date(recordedAt.getTime());
      const entry = unwrap(
        record({ occurredAt: occurred, recordedAt: recorded }),
      );
      occurred.setTime(0);
      recorded.setTime(0);
      entry.occurredAt.setTime(0);
      entry.recordedAt.setTime(0);
      expect(entry.occurredAt).toEqual(occurredAt);
      expect(entry.recordedAt).toEqual(recordedAt);
    });
  });

  describe('event type', () => {
    it.each([
      'a.v1',
      'x.v9',
      'x.v123456',
      'a0_.-z.v10',
      `${'a'.repeat(120)}.v1`,
    ])('accepts %s', (eventType) => {
      expect(unwrap(record({ eventType })).eventType).toBe(eventType);
    });

    it.each([
      '',
      '.v1',
      'x.v0',
      'x.v01',
      'x.v1234567',
      'x.v',
      'X.v1',
      'x.V1',
      'x v1',
      'xv1',
      'x.v1.',
      'x.v1 ',
      ' x.v1',
      'X!a.v1',
      'a.v1!b',
      `${'a'.repeat(121)}.v1`,
    ])('rejects %j', (eventType) => {
      expect(failureType(record({ eventType }))).toBe(
        'audit.invalid_event_type',
      );
    });

    it('rejects a non-string event type', () => {
      expect(failureType(record({ eventType: 12 as unknown as string }))).toBe(
        'audit.invalid_event_type',
      );
    });

    it('rejects a non-string event type even if it stringifies validly', () => {
      expect(
        failureType(
          record({ eventType: ['document.processed.v1'] as unknown as string }),
        ),
      ).toBe('audit.invalid_event_type');
    });

    it('checks the event type before the subject', () => {
      expect(
        failureType(
          record({ eventType: 'bad', subject: { kind: 'BAD', id: subjectId } }),
        ),
      ).toBe('audit.invalid_event_type');
    });
  });

  describe('subject', () => {
    it.each(['a', 'document', 'a0_.-z', `a${'b'.repeat(63)}`])(
      'accepts kind %s',
      (kind) => {
        expect(unwrap(record({ subject: { kind, id: subjectId } })).subject).toEqual({
          kind,
          id: subjectId,
        });
      },
    );

    it.each([
      '',
      '0doc',
      'Doc',
      '_doc',
      'doc ument',
      ' doc',
      'doc ',
      'X!doc',
      'doc!',
      `a${'b'.repeat(64)}`,
    ])('rejects kind %j', (kind) => {
      expect(failureType(record({ subject: { kind, id: subjectId } }))).toBe(
        'audit.invalid_subject',
      );
    });

    it('rejects a non-string kind', () => {
      expect(
        failureType(
          record({ subject: { kind: 3 as unknown as string, id: subjectId } }),
        ),
      ).toBe('audit.invalid_subject');
    });

    it('rejects a non-string kind even if it stringifies validly', () => {
      expect(
        failureType(
          record({
            subject: { kind: ['document'] as unknown as string, id: subjectId },
          }),
        ),
      ).toBe('audit.invalid_subject');
    });

    it('does not share the subject with the caller or the reader', () => {
      const subject = { kind: 'document', id: subjectId };
      const entry = unwrap(record({ subject }));
      subject.kind = 'changed';
      const read = entry.subject;
      if (read === null) throw new Error('subject expected');
      (read as { kind: string }).kind = 'mutated';
      expect(entry.subject).toEqual({ kind: 'document', id: subjectId });
    });
  });

  describe('provenance', () => {
    it('keeps the full work snapshot', () => {
      const provenance = unwrap(record({ work: richWork })).provenance;
      const expected = snapshot();
      expect(provenance.workId).toBe(workId);
      expect(provenance.correlationId).toBe(eventId);
      expect(provenance.correlationSource).toBe('external');
      expect(provenance.operation).toBe('document.process');
      expect(provenance.origin).toBe('replay');
      expect(provenance.depth).toBe(1);
      expect(provenance.attribution).toEqual({
        initiator: { kind: 'user', identity: 'user-1' },
        onBehalfOf: { kind: 'service', identity: 'svc-1' },
        tenant: 'tenant-1',
      });
      expect(provenance.causation).toEqual(expected.causation);
      expect(provenance.replay).toEqual({
        runId,
        source: { kind: 'event', id: sourceId },
      });
    });

    it('omits absent optional parts', () => {
      const provenance = unwrap(record()).provenance;
      expect(provenance.causation).toBeUndefined();
      expect(provenance.replay).toBeUndefined();
      expect(provenance.attribution.initiator).toEqual({ kind: 'anonymous' });
      expect(provenance.attribution.onBehalfOf).toBeUndefined();
      expect(provenance.attribution.tenant).toBeUndefined();
    });

    it('returns deeply frozen copies', () => {
      const entry = unwrap(record({ work: richWork }));
      const provenance = entry.provenance;
      expect(provenance).not.toBe(entry.provenance);
      expect(Object.isFrozen(provenance)).toBe(true);
      expect(Object.isFrozen(provenance.attribution)).toBe(true);
      expect(Object.isFrozen(provenance.attribution.initiator)).toBe(true);
      expect(Object.isFrozen(provenance.attribution.onBehalfOf)).toBe(true);
      expect(Object.isFrozen(provenance.causation)).toBe(true);
      expect(Object.isFrozen(provenance.replay)).toBe(true);
      expect(Object.isFrozen(provenance.replay?.source)).toBe(true);
      expect(provenance.attribution).not.toBe(entry.provenance.attribution);
      expect(provenance.attribution.initiator).not.toBe(initiator);
      expect(provenance.causation).not.toBe(entry.provenance.causation);
      expect(provenance.replay).not.toBe(entry.provenance.replay);
      expect(provenance.replay?.source).not.toBe(
        entry.provenance.replay?.source,
      );
    });
  });

  describe('restore', () => {
    it('restores a stored entry and its provenance', () => {
      const entry = unwrap(restore());
      expect(entry.id).toBe(entryId);
      expect(entry.eventType).toBe('document.processed.v1');
      expect(entry.tenant).toBe(tenantId);
      expect(entry.subject).toEqual({ kind: 'document', id: subjectId });
      expect(entry.provenance.operation).toBe('document.process');
      expect(entry.provenance.replay?.runId).toBe(runId);
    });

    it('rejects invalid provenance and keeps the cause', () => {
      const result = restore({
        work: { ...snapshot(), origin: 'request' },
      });
      expect(failureType(result)).toBe('audit.invalid_provenance');
      if (!result.ok) {
        expect(causeOf(result.error)).toMatchObject({
          type: 'provenance.invalid_origin',
        });
      }
    });

    it('applies the record rules after provenance', () => {
      expect(failureType(restore({ eventType: 'bad' }))).toBe(
        'audit.invalid_event_type',
      );
      expect(failureType(restore({ recordedAt: new Date(Number.NaN) }))).toBe(
        'audit.invalid_time',
      );
    });
  });
});
