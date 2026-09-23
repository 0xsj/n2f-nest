import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryIdentityStore } from '../src/modules/identity/infra/in-memory/index.js';
import { EVENT_BUS, type EventBus } from '../src/platform/events/event-bus.js';
import { EVENT_INBOX } from '../src/platform/events/event-delivery.js';
import { EventMaintenance } from '../src/platform/runtime/event-maintenance.js';
import { FaultInjector } from '../src/platform/chaos/index.js';
import { InMemoryInbox } from '../src/shared/events/index.js';
import { createChaosApplication } from './support/chaos-harness.js';
import { eventually } from './support/eventually.js';

const enabled = process.env.N2F_RUN_CHAOS_INTEGRATION === '1';
const integration = enabled ? describe : describe.skip;

type AuditEntry = { eventId: string; subject?: { id?: string } };

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

  beforeEach(() => {
    faults?.reset();
  });

  afterAll(async () => {
    await app?.close();
  });

  function running() {
    if (!app || !faults) throw new Error('chaos application was not initialized');
    return { app, faults, server: app.getHttpServer() };
  }

  async function register() {
    const { server } = running();
    const response = await request(server)
      .post('/identity/register')
      .send({ email: `chaos-${randomUUID()}@example.com`, password: 'correct horse battery staple' });
    expect(response.status).toBe(202);
    const event = running()
      .app.get(InMemoryIdentityStore)
      .events.findLast((candidate) => candidate.type === 'identity.registered.v1')!;
    expect(event).toBeDefined();
    return { identityId: event.subject!.id, event };
  }

  async function auditFor(eventId: string, expected: number) {
    const { server } = running();
    return eventually(
      async () => {
        const audit = await request(server).get('/audit/entries');
        return (audit.body as AuditEntry[]).filter((entry) => entry.eventId === eventId);
      },
      (entries) => entries.length === expected,
    );
  }

  it('retries a consumer whose acknowledgement was lost without duplicating the Audit projection', async () => {
    const { faults } = running();
    faults.arm({
      point: 'event.consume.after',
      action: 'fail',
      consumer: 'audit',
      failure: {
        kind: 'unavailable',
        message: 'subscriber acknowledgement lost',
        type: 'chaos.subscriber_ack_lost',
      },
    });

    const { event } = await register();

    expect(await auditFor(event.id, 1)).toHaveLength(1);
    expect(faults.observations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ point: 'event.consume.after', affected: true }),
      ]),
    );
  });

  it('accepts a replayed publication after an ambiguous acknowledgement exactly once', async () => {
    const { app, faults } = running();
    const { event } = await register();
    await auditFor(event.id, 1);
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

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await auditFor(event.id, 1)).toHaveLength(1);
  });

  it('never fails the producer when a consumer keeps failing, and dead-letters only that consumer', async () => {
    const { app, faults, server } = running();
    faults.arm({
      point: 'event.consume.before',
      action: 'fail',
      times: 'always',
      consumer: 'audit',
    });

    // register() asserts 202: the write committed although Audit cannot consume.
    const { identityId, event } = await register();

    const inbox = app.get(EVENT_INBOX) as InMemoryInbox;
    const dead = await eventually(
      async () => inbox.dead('audit'),
      (ids) => ids.includes(event.id),
    );
    expect(dead).toContain(event.id);
    expect(inbox.dead('document-processing')).not.toContain(event.id);
    // Dead letters are visible to monitoring.
    await app.get(EventMaintenance).measure();
    const metrics = (await request(server).get('/metrics')).text;
    expect(metrics).toMatch(/n2f_event_deliveries_total\{consumer="audit",outcome="dead"\} [1-9]/);
    expect(metrics).toMatch(/n2f_event_inbox_backlog\{consumer="audit",state="dead"\} [1-9]/);
    faults.reset();
    const audit = await request(server).get('/audit/entries');
    expect(
      (audit.body as AuditEntry[]).filter((entry) => entry.subject?.id === identityId),
    ).toHaveLength(0);
  });
});
