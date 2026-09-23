import { randomUUID } from 'node:crypto';
import { SecretString } from '../../secret/index.js';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../errors/index.js';
import { parse } from '../../id/index.js';
import { Envelope, type Publisher, type Receipt } from '../index.js';
import {
  ChaosPublisher,
  FaultInjector,
} from '../../../platform/chaos/index.js';
import {
  anonymous,
  attribution,
  operation,
  restoreWork,
} from '../../provenance/index.js';
import { describe, expect, it } from 'vitest';
import { Broker } from './broker.js';

const enabled = process.env.N2F_RUN_NATS_INTEGRATION === '1';
const integration = enabled ? describe : describe.skip;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fixture(): Envelope {
  const ids = [
    '01900000-0000-7000-8000-000000000001',
    '01900000-0000-7000-8000-000000000002',
  ].map((value) => parse(value));
  if (ids.some((value) => !value.ok)) throw new Error('fixture IDs invalid');

  const [workId, correlationId] = ids.map((value) => {
    if (!value.ok) throw new Error('fixture ID invalid');
    return value.value;
  });
  const eventId = parse(randomUUID());
  if (!eventId.ok) throw new Error('random event ID invalid');
  const work = restoreWork({
    workId,
    correlationId,
    correlationSource: 'local',
    operation: operation('events.retry.test').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'message',
  });
  if (!work.ok) throw new Error(work.error.message);

  const event = Envelope.create(
    eventId.value,
    'events.retry.test.v1',
    Date.now(),
    work.value,
    { retry: true },
  );
  if (!event.ok) throw new Error(event.error.message);
  return event.value;
}

integration('NATS JetStream delivery', () => {
  it('redelivers when the destination subscriber fails before ACK', async () => {
    const url = process.env.N2F_NATS_URL;
    if (!url) throw new Error('N2F_NATS_URL is required');

    const suffix = Date.now().toString(36);
    const stream = process.env.N2F_NATS_STREAM ?? 'n2f_events';
    const subjectPrefix = process.env.N2F_NATS_SUBJECT_PREFIX;
    const opened = await Broker.open({
      url: new SecretString(url),
      stream,
      subjectPrefix,
      consumer: `retry_${suffix}`,
      timeoutMs: 2000,
      consumerDeliverPolicy: 'new',
      nakDelayMs: 200,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const broker = opened.value;
    try {
      expect((await broker.provision()).ok).toBe(true);

      const event = fixture();
      expect((await broker.publish(event)).ok).toBe(true);

      const failing: Publisher = {
        publish: async (): Promise<Result<Receipt, Failure>> =>
          err(failure('unavailable', 'test subscriber unavailable')),
      };
      const rejected = await broker.transfer(failing);
      expect(rejected.ok).toBe(false);

      // A refused delivery is NAKed with a delay; JetStream redelivers after it.
      await delay(400);

      let received: Envelope | undefined;
      const successful: Publisher = {
        publish: async (candidate): Promise<Result<Receipt, Failure>> => {
          received = candidate;
          return ok({ eventId: candidate.id, durable: true });
        },
      };
      const delivered = await broker.transfer(successful);

      expect(delivered).toEqual(ok(true));
      expect(received?.id).toBe(event.id);
    } finally {
      await broker.removeConsumer();
      await broker.close();
    }
  });

  it('recovers when the publisher loses the acknowledgement after NATS accepts the event', async () => {
    const url = process.env.N2F_NATS_URL;
    if (!url) throw new Error('N2F_NATS_URL is required');

    const suffix = Date.now().toString(36);
    const stream = process.env.N2F_NATS_STREAM ?? 'n2f_events';
    const subjectPrefix = process.env.N2F_NATS_SUBJECT_PREFIX;
    const opened = await Broker.open({
      url: new SecretString(url),
      stream,
      subjectPrefix,
      consumer: `chaos_${suffix}`,
      timeoutMs: 2000,
      consumerDeliverPolicy: 'new',
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const broker = opened.value;
    try {
      expect((await broker.provision()).ok).toBe(true);
      const faults = new FaultInjector();
      faults.arm({
        point: 'publisher.publish.after',
        action: 'fail',
        failure: failure(
          'timeout',
          'test publisher acknowledgement timed out',
          { type: 'chaos.publisher_ack_timeout' },
        ),
      });
      const publisher = new ChaosPublisher(broker, faults);
      const event = fixture();

      const uncertain = await publisher.publish(event);
      expect(uncertain.ok).toBe(false);

      const replayed = await publisher.publish(event);
      expect(replayed).toEqual(ok({ eventId: event.id, durable: true }));
    } finally {
      await broker.removeConsumer();
      await broker.close();
    }
  });
});
