import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { Envelope, type Publisher } from '../../shared/events/index.js';
import { Store as EventStore, Mailbox, migration as eventsMigration, receiptsMigration } from '../../shared/events/postgres/store.js';
import { Broker, type Config as BrokerConfig } from '../../shared/events/jetstream/broker.js';
import { err, failure, ok, type Failure, type Result } from '../../shared/errors/index.js';
import { parse, type ID, V7 } from '../../shared/id/index.js';
import { Reply } from '../../shared/http/feature.js';
import type { RequestContext, Route } from '../../shared/http/nest/server.js';
import type { Database, Migration } from '../../shared/postgres/index.js';
import type { Origin } from '../../shared/provenance/index.js';
import type { Logger } from '../../shared/logger/index.js';

export const migration = (version: number): Migration => ({
  version,
  sql: readFileSync(new URL('./migrations/0004_audit.sql', import.meta.url), 'utf8'),
});

type Actor = { kind: string; identity: string };
type RecordValue = {
  id: ID;
  eventId: ID;
  occurredAtMs: number;
  recordedAtMs: number;
  action: string;
  outcome: 'succeeded';
  actor: Actor;
  subjectId: ID;
  tenant?: string;
  workId: ID;
  correlationId: ID;
  causationId?: ID;
  origin?: Origin;
  details: Record<string, unknown>;
};
const invalid = (code: string): Failure =>
  failure('invalid', 'invalid audit record', { type: `audit.${code}` });

export class Store {
  constructor(readonly database: Database) {}
  async insert(tx: pg.PoolClient, record: RecordValue): Promise<Result<void, Failure>> {
    if (
      record.id !== record.eventId ||
      !record.action ||
      record.outcome !== 'succeeded' ||
      !Number.isSafeInteger(record.occurredAtMs) ||
      !Number.isSafeInteger(record.recordedAtMs) ||
      typeof record.details !== 'object' ||
      record.details === null ||
      Array.isArray(record.details)
    )
      return err(invalid('invalid_record'));
    try {
      await tx.query(
        `INSERT INTO public.n2f_audit_records
 (event_id,occurred_at_ms,recorded_at_ms,action,outcome,actor_kind,actor_identity,subject_id,tenant,work_id,correlation_id,causation_id,origin,details)
 VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8::uuid,$9,$10::uuid,$11::uuid,$12::uuid,$13,$14)
 ON CONFLICT(event_id) DO NOTHING`,
        [
          record.eventId,
          record.occurredAtMs,
          record.recordedAtMs,
          record.action,
          record.outcome,
          record.actor.kind,
          record.actor.identity,
          record.subjectId,
          record.tenant ?? null,
          record.workId,
          record.correlationId,
          record.causationId ?? null,
          record.origin ?? null,
          JSON.stringify(record.details),
        ],
      );
      return ok(undefined);
    } catch (e) {
      return err(failure('internal', 'audit write failed', { type: 'audit.write_failed', cause: e }));
    }
  }
  async list(limit: number): Promise<Result<Record<string, unknown>[], Failure>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return err(invalid('invalid_query'));
    return this.database.transaction(async (tx) => {
      try {
        const rows = (
          await tx.query(
            `SELECT event_id,occurred_at_ms,recorded_at_ms,action,outcome,actor_kind,actor_identity,subject_id,tenant,work_id,correlation_id,causation_id,origin,details::text AS details
 FROM public.n2f_audit_records ORDER BY recorded_at_ms DESC,event_id DESC LIMIT $1`,
            [limit],
          )
        ).rows;
        return ok(
          rows.map((row) => ({
            id: row.event_id,
            event_id: row.event_id,
            occurred_at_ms: Number(row.occurred_at_ms),
            recorded_at_ms: Number(row.recorded_at_ms),
            action: row.action,
            outcome: row.outcome,
            actor: { kind: row.actor_kind, ...(row.actor_identity ? { identity: row.actor_identity } : {}) },
            subject_id: row.subject_id,
            ...(row.tenant === null ? {} : { tenant: row.tenant }),
            work_id: row.work_id,
            correlation_id: row.correlation_id,
            ...(row.causation_id === null ? {} : { causation_id: row.causation_id }),
            ...(row.origin === null ? {} : { origin: row.origin }),
            details: JSON.parse(row.details),
          })),
        );
      } catch (e) {
        return err(failure('internal', 'audit read failed', { type: 'audit.read_failed', cause: e }));
      }
    });
  }
}

export function translate(event: Envelope, recordedAtMs: number): Result<RecordValue | undefined, Failure> {
  let wire: any;
  try { wire = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(event.bytes())); } catch { return err(invalid('invalid_event')); }
  const supported = new Set([
    'identity.principal.registered.v1',
    'identity.email.verified.v1',
    'identity.session.created.v1',
    'identity.session.revoked.v1',
    'identity.sessions.revoked.v1',
    'identity.password.changed.v1',
  ]);
  if (!supported.has(wire.type)) return ok(undefined);
  const subject = parse(wire.payload?.principal_id);
  if (!subject.ok) return err(invalid('invalid_event'));
  const work = event.work.snapshot(), initiator = work.attribution.initiator;
  const actorValue = initiator ?? { kind: 'anonymous' as const };
  return actorValue.kind !== 'anonymous' && !actorValue.identity
    ? err(invalid('invalid_event'))
    : ok({
        id: event.id,
        eventId: event.id,
        occurredAtMs: wire.occurred_at_ms,
        recordedAtMs,
        action: wire.type,
        outcome: 'succeeded',
        actor: { kind: actorValue.kind, identity: actorValue.identity ?? '' },
        subjectId: subject.value,
        ...(work.attribution.tenant ? { tenant: work.attribution.tenant } : {}),
        workId: work.workId,
        correlationId: work.correlationId,
        ...(work.causation ? { causationId: work.causation.id } : {}),
        ...(work.origin ? { origin: work.origin } : {}),
        details: wire.payload,
      });
}

function limitFromQuery(query: string): Result<number, Failure> {
  const params = new URLSearchParams(query), value = params.get('limit');
  if (params.has('limit') && (params.getAll('limit').length !== 1 || !/^\d+$/.test(value ?? '')))
    return err(invalid('invalid_query'));
  const limit = value === null ? 50 : Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? ok(limit) : err(invalid('invalid_query'));
}
export function route(admission: NonNullable<Route['admission']>, store: Store): Route {
  return {
    path: '/v1/audit/records',
    method: 'GET',
    operation: 'audit.http.records',
    admission,
    handler: async (context) => {
      const limit = limitFromQuery(context.request.query);
      if (!limit.ok) return limit;
      const records = await store.list(limit.value);
      return records.ok
        ? Reply.create({ status: 200, body: { records: records.value, limit: limit.value }, headers: { 'Cache-Control': 'no-store' } })
        : records;
    },
  };
}

export class Runtime {
  #stop = new AbortController();
  #task?: Promise<void>;
  readonly #ids: V7;
  constructor(
    private readonly events: EventStore,
    private readonly mailbox: Mailbox,
    private readonly audit: Store,
    private readonly publisher: Publisher,
    private readonly broker: Broker | undefined,
    private readonly consumer: string,
    private readonly intervalMs: number,
    private readonly clock: { now(): Date },
    private readonly log: Logger,
  ) { this.#ids = new V7(clock); }
  start() {
    this.#task = this.#loop();
  }
  async close(budgetMs: number) {
    this.#stop.abort();
    if (this.#task) await Promise.race([this.#task, new Promise((resolve) => setTimeout(resolve, budgetMs))]);
    await this.broker?.close();
  }
  async #loop() {
    while (!this.#stop.signal.aborted) {
      await this.#tick();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.intervalMs);
        this.#stop.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }
  async #tick() {
    const token = this.#ids.newId();
    if (!token.ok) return;
    const dispatched = await this.events.dispatch(this.publisher, token.value, this.#stop.signal);
    if (!dispatched.ok) { this.log.withError(dispatched.error).warn('audit.worker_failed'); return; }
    if (this.broker) {
      const transferred = await this.broker.transfer(this.mailbox, this.#stop.signal);
      if (!transferred.ok) { this.log.withError(transferred.error).warn('audit.worker_failed'); return; }
    }
    const recorded = this.clock.now().getTime();
    const consumed = await this.mailbox.consume(this.consumer, async (tx, event) => {
      const record = translate(event, recorded);
      if (!record.ok || !record.value) return record.ok ? ok(undefined) : record;
      return this.audit.insert(tx, record.value);
    });
    if (!consumed.ok) this.log.withError(consumed.error).warn('audit.worker_failed');
  }
}

export async function compose(
  database: Database,
  eventsConfig: { broker?: BrokerConfig; intervalMs: number },
  admission: NonNullable<Route['admission']>,
  consumer: string,
  clock: { now(): Date },
  log: Logger,
  identitySchema: Migration,
  upgradeTicketSchema: Migration,
  orgSchema: Migration,
  orgWorkflowSchema: Migration,
): Promise<Result<{ route: Route; runtime: Runtime }, Failure>> {
  const migrated = await database.migrate([
    eventsMigration(1),
    identitySchema,
    receiptsMigration(3),
    migration(4),
    upgradeTicketSchema,
    orgSchema,
    orgWorkflowSchema,
  ]);
  if (!migrated.ok) return migrated;
  const events = new EventStore(database), mailbox = new Mailbox(database), audit = new Store(database);
  let broker: Broker | undefined;
  if (eventsConfig.broker) {
    const opened = await Broker.open(eventsConfig.broker);
    if (!opened.ok) return opened;
    broker = opened.value;
    const provisioned = await broker.provision();
    if (!provisioned.ok) { await broker.close(); return provisioned; }
  }
  const publisher = broker ?? mailbox;
  const runtime = new Runtime(events, mailbox, audit, publisher, broker, consumer, eventsConfig.intervalMs, clock, log);
  return ok({ route: route(admission, audit), runtime });
}
