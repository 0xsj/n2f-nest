import { describe, expect, it } from 'vitest';
import { parse, type ID } from '../../../shared/id/index.js';
import {
  anonymous,
  attribution,
  operation,
  restoreWork,
} from '../../../shared/provenance/index.js';
import { AuditEntry } from '../domain/index.js';
import { InMemoryAuditEntryReader, InMemoryAuditEntryWriter } from './in-memory/adapters.js';
import { InMemoryAuditStore } from './in-memory/store.js';

function id(value: string): ID {
  const result = parse(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function entry() {
  const eventId = id('00000000-0000-7000-8000-000000000062');
  const work = restoreWork({
    workId: id('00000000-0000-7000-8000-000000000061'),
    correlationId: eventId,
    correlationSource: 'local',
    operation: operation('organization.create').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'message',
  });
  if (!work.ok) throw new Error(work.error.message);

  const result = AuditEntry.record({
    id: id('00000000-0000-7000-8000-000000000063'),
    eventId,
    eventType: 'organization.created.v1',
    occurredAt: new Date('2026-09-22T00:00:00.000Z'),
    recordedAt: new Date('2026-09-22T00:00:01.000Z'),
    work: work.value,
    subject: {
      kind: 'organization',
      id: id('00000000-0000-7000-8000-000000000064'),
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('Audit in-memory adapter contract', () => {
  it('records an entry once and exposes it through the reader', async () => {
    const store = new InMemoryAuditStore();
    const writer = new InMemoryAuditEntryWriter(store);
    const reader = new InMemoryAuditEntryReader(store);
    const value = entry();

    const recorded = await writer.record(value);
    const listed = await reader.list();

    expect(recorded).toEqual({ ok: true, value: { entry: value, created: true } });
    expect(listed).toEqual({ ok: true, value: [value] });
  });

  it('returns the original projection on duplicate source event delivery', async () => {
    const store = new InMemoryAuditStore();
    const writer = new InMemoryAuditEntryWriter(store);
    const first = entry();
    const duplicate = await writer.record(first);

    const replayed = await writer.record(entry());

    expect(duplicate).toEqual({ ok: true, value: { entry: first, created: true } });
    expect(replayed).toEqual({ ok: true, value: { entry: first, created: false } });
    expect(store.list()).toHaveLength(1);
  });
});
