import { failure } from '../../shared/errors/index.js';
import { ok } from '../../shared/errors/index.js';
import type {
  Envelope,
  Publisher,
  Receipt,
} from '../../shared/events/index.js';
import type { ID } from '../../shared/id/index.js';
import type { OutboxStore } from '../events/outbox-dispatcher.js';
import {
  ChaosOutboxStore,
  ChaosPublisher,
  ChaosTransactionDatabase,
} from './index.js';
import type { TransactionDatabase } from '../../shared/postgres/index.js';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { FaultInjector } from './fault-injector.js';

const id = '01900000-0000-7000-8000-000000000001' as ID;
const event = {} as Envelope;

class PublisherSpy implements Publisher {
  calls = 0;

  async publish(): Promise<{ readonly ok: true; readonly value: Receipt }> {
    this.calls += 1;
    return ok({ eventId: id, durable: true });
  }
}

describe('FaultInjector', () => {
  it('applies a one-shot failure and then lets the boundary recover', async () => {
    const faults = new FaultInjector();
    faults.arm({
      point: 'event.publish.before',
      action: 'fail',
      failure: failure('unavailable', 'publisher unavailable', {
        type: 'test.publisher_unavailable',
      }),
    });

    const failed = await faults.hit('event.publish.before');
    const recovered = await faults.hit('event.publish.before');

    expect(failed.ok).toBe(false);
    expect(recovered).toEqual({ ok: true, value: undefined });
    expect(faults.observations()).toHaveLength(1);
  });

  it('supports repeated faults and preserves observations', async () => {
    const faults = new FaultInjector();
    faults.arm({
      point: 'event.consume.before',
      action: 'fail',
      times: 2,
    });

    expect((await faults.hit('event.consume.before')).ok).toBe(false);
    expect((await faults.hit('event.consume.before')).ok).toBe(false);
    expect((await faults.hit('event.consume.before')).ok).toBe(true);
    expect(faults.observations()).toHaveLength(2);
  });

  it('returns cancellation when a delayed fault meets an aborted signal', async () => {
    const faults = new FaultInjector();
    const controller = new AbortController();
    controller.abort();
    faults.arm({
      point: 'database.transaction.before',
      action: 'delay',
      delayMs: 10,
    });

    const result = await faults.hit(
      'database.transaction.before',
      controller.signal,
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          kind: 'canceled',
          type: 'chaos.canceled',
        }),
      }),
    );
  });

  it('wraps a generic publisher after delivery', async () => {
    const faults = new FaultInjector();
    const delegate = new PublisherSpy();
    const publisher = new ChaosPublisher(delegate, faults);
    faults.arm({ point: 'publisher.publish.after', action: 'fail' });

    expect((await publisher.publish(event)).ok).toBe(false);
    expect(delegate.calls).toBe(1);
    expect((await publisher.publish(event)).ok).toBe(true);
  });

  it('wraps an outbox store after dispatch', async () => {
    const faults = new FaultInjector();
    let calls = 0;
    const delegate: OutboxStore = {
      dispatch: async () => {
        calls += 1;
        return ok(true);
      },
    };
    const store = new ChaosOutboxStore(delegate, faults);
    faults.arm({ point: 'outbox.dispatch.after', action: 'fail' });

    expect((await store.dispatch(publisher(), id)).ok).toBe(false);
    expect(calls).toBe(1);
    expect((await store.dispatch(publisher(), id)).ok).toBe(true);
  });

  it('wraps a transaction database before and after the transaction', async () => {
    const faults = new FaultInjector();
    let calls = 0;
    const delegate: TransactionDatabase = {
      transaction: async <T>(
        fn: (
          transaction: pg.PoolClient,
          signal: AbortSignal,
        ) => Promise<{ readonly ok: true; readonly value: T }>,
        signal?: AbortSignal,
      ) => {
        calls += 1;
        return fn({} as pg.PoolClient, signal ?? new AbortController().signal);
      },
    };
    const database = new ChaosTransactionDatabase(delegate, faults);
    faults.arm({ point: 'database.transaction.after', action: 'fail' });

    const work = async () => ok('committed');
    expect((await database.transaction(work)).ok).toBe(false);
    expect(calls).toBe(1);
    expect((await database.transaction(work)).ok).toBe(true);
  });
});

function publisher(): Publisher {
  return new PublisherSpy();
}
