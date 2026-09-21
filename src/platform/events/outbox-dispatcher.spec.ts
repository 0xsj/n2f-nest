import { describe, expect, it } from 'vitest';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../shared/errors/index.js';
import type { ID, IDGenerator } from '../../shared/id/index.js';
import type {
  Envelope,
  Publisher,
  Receipt,
} from '../../shared/events/index.js';
import { OutboxDispatcher, type OutboxStore } from './outbox-dispatcher.js';

const token = '01900000-0000-7000-8000-000000000001' as ID;

class FixedIds implements IDGenerator {
  newId(): Result<ID, Failure> {
    return ok(token);
  }
}

class FailingIds implements IDGenerator {
  newId(): Result<ID, Failure> {
    return err(failure('unavailable', 'ID generation failed'));
  }
}

class PublisherSpy implements Publisher {
  publish(
    _event: Envelope,
    _signal?: AbortSignal,
  ): Promise<Result<Receipt, Failure>> {
    return Promise.resolve(ok({ eventId: token, durable: true }));
  }
}

describe('OutboxDispatcher', () => {
  it('delegates one attempt with a fresh lease token', async () => {
    const publisher = new PublisherSpy();
    let received: { publisher: Publisher; token: ID; signal?: AbortSignal } | undefined;
    const store: OutboxStore = {
      dispatch: (candidate, attempt, signal) => {
        received = { publisher: candidate, token: attempt, signal };
        return Promise.resolve(ok(true));
      },
    };
    const signal = new AbortController().signal;

    const result = await new OutboxDispatcher(store, publisher, new FixedIds())
      .dispatchOnce(signal);

    expect(result).toEqual(ok(true));
    expect(received).toEqual({ publisher, token, signal });
  });

  it('does not call the store when token generation fails', async () => {
    let called = false;
    const store: OutboxStore = {
      dispatch: () => {
        called = true;
        return Promise.resolve(ok(true));
      },
    };

    const result = await new OutboxDispatcher(
      store,
      new PublisherSpy(),
      new FailingIds(),
    ).dispatchOnce();

    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });
});
