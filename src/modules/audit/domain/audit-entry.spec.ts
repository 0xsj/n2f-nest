import { describe, expect, it } from 'vitest';
import { parse } from '../../../shared/id/index.js';
import {
  anonymous,
  attribution,
  operation,
  restoreWork,
} from '../../../shared/provenance/index.js';
import { AuditEntry } from './audit-entry.js';

const id = parse('00000000-0000-7000-8000-000000000001');
const eventId = parse('00000000-0000-7000-8000-000000000002');
const subjectId = parse('00000000-0000-7000-8000-000000000003');

if (!id.ok || !eventId.ok || !subjectId.ok) {
  throw new Error('audit fixture IDs should be valid');
}

const work = restoreWork({
  workId: id.value,
  correlationId: eventId.value,
  correlationSource: 'local',
  operation: operation('identity.register').value,
  attribution: attribution({ initiator: anonymous() }).value,
  origin: 'request',
});

if (!work.ok) throw new Error('audit fixture work should be valid');

describe('AuditEntry', () => {
  it('records event metadata, subject and provenance without the payload', () => {
    const result = AuditEntry.record({
      id: id.value,
      eventId: eventId.value,
      eventType: 'identity.registered.v1',
      occurredAt: new Date('2026-09-19T00:00:00.000Z'),
      recordedAt: new Date('2026-09-19T00:00:01.000Z'),
      work: work.value,
      subject: { kind: 'identity', id: subjectId.value },
      tenant: null,
    });

    expect(result.ok).toBe(true);
    expect(result.value?.eventType).toBe('identity.registered.v1');
    expect(result.value?.subject).toEqual({
      kind: 'identity',
      id: subjectId.value,
    });
    expect(result.value?.provenance.operation).toBe('identity.register');
  });

  it('rejects an unversioned event type', () => {
    const result = AuditEntry.record({
      id: id.value,
      eventId: eventId.value,
      eventType: 'identity.registered',
      occurredAt: new Date(),
      recordedAt: new Date(),
      work: work.value,
      subject: null,
      tenant: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('audit.invalid_event_type');
  });
});
