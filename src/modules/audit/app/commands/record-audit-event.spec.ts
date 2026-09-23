import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../../shared/clock/index.js';
import { ok, type Result } from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import { parse, type ID, type IDGenerator } from '../../../../shared/id/index.js';
import {
  anonymous,
  attribution,
  operation,
  restoreWork,
} from '../../../../shared/provenance/index.js';
import { AuditEntry } from '../../domain/index.js';
import {
  RecordAuditEvent,
  type RecordAuditEventCommand,
} from './record-audit-event.js';
import type { AuditEntryWriter, AuditWriteResult } from '../ports/index.js';

const values = [
  '00000000-0000-7000-8000-000000000001',
  '00000000-0000-7000-8000-000000000002',
  '00000000-0000-7000-8000-000000000003',
].map((value) => parse(value));

if (values.some((value) => !value.ok)) throw new Error('audit IDs invalid');
const ids: ID[] = values.map((value) => {
  if (!value.ok) throw new Error('audit ID invalid');
  return value.value;
});

class TestIds implements IDGenerator {
  newId(): Result<ID, never> {
    return ok(ids[2]!);
  }
}

function command(withSubject = true): RecordAuditEventCommand {
  const work = restoreWork({
    workId: ids[0]!,
    correlationId: ids[1]!,
    correlationSource: 'local',
    operation: operation('identity.register').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'request',
  });
  if (!work.ok) throw new Error('audit work invalid');

  const event = Envelope.create(
    ids[1]!,
    'identity.registered.v1',
    1000,
    work.value,
    { identity_id: ids[0]!, status: 'pending_verification' },
    withSubject ? { kind: 'identity', id: ids[0]! } : undefined,
  );
  if (!event.ok) throw new Error('audit event invalid');
  return { event: event.value };
}

describe('RecordAuditEvent', () => {
  it('projects safe event metadata and subject identity', async () => {
    let received: AuditEntry | undefined;
    const writer: AuditEntryWriter = {
      record: async (entry): Promise<Result<AuditWriteResult, never>> => {
        received = entry;
        return ok({ entry, created: true });
      },
    };
    const useCase = new RecordAuditEvent({
      clock: new FakeClock(new Date(2000)),
      ids: new TestIds(),
      writer,
    });

    const result = await useCase.execute(command());

    expect(result.ok).toBe(true);
    expect(received?.eventType).toBe('identity.registered.v1');
    expect(received?.subject).toEqual({ kind: 'identity', id: ids[0] });
    expect(received?.provenance.workId).toBe(ids[0]);
  });

  it('takes the subject only from the envelope, never from payload fields', async () => {
    let received: AuditEntry | undefined;
    const writer: AuditEntryWriter = {
      record: async (entry): Promise<Result<AuditWriteResult, never>> => {
        received = entry;
        return ok({ entry, created: true });
      },
    };
    const useCase = new RecordAuditEvent({
      clock: new FakeClock(new Date(2000)),
      ids: new TestIds(),
      writer,
    });

    const result = await useCase.execute(command(false));

    expect(result.ok).toBe(true);
    expect(received?.subject).toBeNull();
  });

  it('preserves a no-subject event as a valid audit fact', async () => {
    const original = command(false);
    const raw = JSON.parse(new TextDecoder().decode(original.event.bytes())) as Record<string, unknown>;
    const withoutSubject = Envelope.decode(
      Buffer.from(JSON.stringify({ ...raw, payload: { status: 'ok' } })),
    );
    if (!withoutSubject.ok) throw new Error('audit event invalid');

    let received: AuditEntry | undefined;
    const useCase = new RecordAuditEvent({
      clock: new FakeClock(new Date(2000)),
      ids: new TestIds(),
      writer: {
        record: async (entry) => {
          received = entry;
          return ok({ entry, created: true });
        },
      },
    });

    await useCase.execute({ event: withoutSubject.value });
    expect(received?.subject).toBeNull();
  });
});
