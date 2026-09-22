import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryIdentityStore } from '../src/modules/identity/infra/in-memory/index.js';
import { EVENT_BUS, type EventBus } from '../src/platform/events/event-bus.js';
import { FaultInjector } from '../src/platform/chaos/index.js';
import { createChaosApplication } from './support/chaos-harness.js';

const enabled = process.env.N2F_RUN_CHAOS_INTEGRATION === '1';
const integration = enabled ? describe : describe.skip;

integration('Chaos resilience integration', () => {
  let app: INestApplication | undefined;
  let faults: FaultInjector | undefined;

  beforeAll(async () => {
    process.env.N2F_STORAGE = 'memory';
    process.env.N2F_EVENT_TRANSPORT = 'local';
    const created = await createChaosApplication();
    app = created.app;
    faults = created.faults;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('replays a consumed event without duplicating the Audit projection', async () => {
    if (!app || !faults)
      throw new Error('chaos application was not initialized');
    const server = app.getHttpServer();
    const email = `chaos-${randomUUID()}@example.com`;
    const registered = await request(server)
      .post('/identity/register')
      .send({ email, password: 'correct horse battery staple' });

    expect(registered.status).toBe(201);
    const identityStore = app.get(InMemoryIdentityStore);
    const event = identityStore.events.at(-1);
    expect(event?.type).toBe('identity.registered.v1');

    faults.arm({
      point: 'event.consume.after',
      action: 'fail',
      failure: {
        kind: 'unavailable',
        message: 'subscriber acknowledgement lost',
        type: 'chaos.subscriber_ack_lost',
      },
    });

    const bus = app.get(EVENT_BUS) as EventBus;
    const failedDelivery = await bus.publish(event!);
    expect(failedDelivery.ok).toBe(false);

    const replayed = await bus.publish(event!);
    expect(replayed.ok).toBe(true);

    const audit = await request(server).get('/audit/entries');
    expect(audit.status).toBe(200);
    expect(
      audit.body.filter(
        (entry: { eventId: string }) => entry.eventId === event!.id,
      ),
    ).toHaveLength(1);
    expect(faults.observations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          point: 'event.consume.after',
          action: 'fail',
          affected: true,
        }),
      ]),
    );
  });

  it('models an ambiguous publisher acknowledgement and recovers on replay', async () => {
    if (!app || !faults)
      throw new Error('chaos application was not initialized');
    const identityStore = app.get(InMemoryIdentityStore);
    const event = identityStore.events.at(-1);
    if (!event) throw new Error('expected an event from the previous scenario');

    faults.reset();
    faults.arm({
      point: 'event.publish.after',
      action: 'fail',
      failure: {
        kind: 'timeout',
        message: 'publisher acknowledgement timed out',
        type: 'chaos.publisher_ack_timeout',
      },
    });

    const bus = app.get(EVENT_BUS) as EventBus;
    const uncertain = await bus.publish(event);
    expect(uncertain.ok).toBe(false);
    const replayed = await bus.publish(event);
    expect(replayed.ok).toBe(true);
  });
});
