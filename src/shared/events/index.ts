/**
 * Versioned event envelopes. Publisher receipts describe handoff/durability,
 * not subscriber completion; consumers own their receipts and idempotency.
 */
import {
  AppError,
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';
import { parse, type ID } from '../id/index.js';
import * as provenance from '../provenance/index.js';

const invalid = () =>
  failure('invalid', 'invalid event envelope', { type: 'events.invalid' });

function value<T>(result: Result<T, Failure>): T {
  if (!result.ok) throw new AppError(result.error);
  return result.value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(invalid());
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new AppError(invalid());
  return value;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new AppError(invalid());
  }
}

function actorIn(value: unknown): provenance.Actor | undefined {
  if (value === undefined || value === null) return undefined;
  const input = object(value);
  keys(input, ['kind', 'identity']);
  return valueOf(
    provenance.actor(
      string(input.kind) as provenance.ActorKind,
      input.identity == null ? '' : string(input.identity),
    ),
  );
}

function valueOf<T>(result: Result<T, Failure>): T {
  return value(result);
}

function referenceIn(value: unknown): provenance.Reference | undefined {
  if (value === undefined || value === null) return undefined;
  const input = object(value);
  keys(input, ['kind', 'id']);
  return valueOf(
    provenance.reference(
      string(input.kind) as provenance.ReferenceKind,
      valueOf(parse(string(input.id))),
    ),
  );
}

function workIn(value: unknown): provenance.WorkContext {
  const input = object(value);
  const attribution = object(input.attribution);
  const replay = input.replay == null ? undefined : object(input.replay);
  keys(input, [
    'work_id',
    'correlation_id',
    'correlation_source',
    'operation',
    'attribution',
    'causation',
    'origin',
    'depth',
    'replay',
  ]);
  keys(attribution, ['initiator', 'on_behalf_of', 'tenant']);
  if (replay) keys(replay, ['run_id', 'source']);

  return valueOf(
    provenance.restoreWork({
      workId: valueOf(parse(string(input.work_id))),
      correlationId: valueOf(parse(string(input.correlation_id))),
      correlationSource: string(
        input.correlation_source,
      ) as provenance.CorrelationSource,
      operation: valueOf(provenance.operation(string(input.operation))),
      attribution: valueOf(
        provenance.attribution({
          initiator: actorIn(attribution.initiator),
          onBehalfOf: actorIn(attribution.on_behalf_of),
          tenant:
            attribution.tenant == null
              ? undefined
              : string(attribution.tenant),
        }),
      ),
      causation: referenceIn(input.causation),
      origin:
        input.origin == null
          ? undefined
          : (string(input.origin) as provenance.Origin),
      depth: input.depth == null ? undefined : (input.depth as number),
      replay: replay
        ? {
            runId: valueOf(parse(string(replay.run_id))),
            source: referenceIn(replay.source)!,
          }
        : undefined,
    }),
  );
}

function workOut(work: provenance.WorkContext): unknown {
  const snapshot = work.snapshot();
  return {
    work_id: snapshot.workId,
    correlation_id: snapshot.correlationId,
    correlation_source: snapshot.correlationSource,
    operation: snapshot.operation,
    attribution: {
      initiator: snapshot.attribution.initiator,
      on_behalf_of: snapshot.attribution.onBehalfOf,
      tenant: snapshot.attribution.tenant,
    },
    causation: snapshot.causation,
    origin: snapshot.origin,
    depth: snapshot.depth,
    replay: snapshot.replay
      ? {
          run_id: snapshot.replay.runId,
          source: snapshot.replay.source,
        }
      : undefined,
  };
}

export class Envelope {
  #raw: Uint8Array;

  private constructor(
    readonly id: ID,
    raw: Uint8Array,
    readonly work: provenance.WorkContext,
    readonly type: string,
    readonly occurredAtMs: number,
  ) {
    this.#raw = raw.slice();
    Object.freeze(this);
  }

  bytes(): Uint8Array {
    return this.#raw.slice();
  }

  /** Returns a detached payload projection for trusted event consumers. */
  payload(): Record<string, unknown> {
    const input = object(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.#raw)),
    );
    return object(input.payload);
  }

  static create(
    id: ID,
    type: string,
    occurredAtMs: number,
    work: provenance.WorkContext,
    payload: Record<string, unknown>,
  ): Result<Envelope, Failure> {
    try {
      return Envelope.decode(
        Buffer.from(
          JSON.stringify({
            v: 1,
            id,
            type,
            occurred_at_ms: occurredAtMs,
            work: workOut(work),
            payload,
          }),
        ),
      );
    } catch {
      return err(invalid());
    }
  }

  static decode(raw: Uint8Array): Result<Envelope, Failure> {
    if (!(raw instanceof Uint8Array) || raw.byteLength > 65536) {
      return err(invalid());
    }

    try {
      const input = object(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)),
      );
      if (
        Object.keys(input).length !== 6 ||
        !['v', 'id', 'type', 'occurred_at_ms', 'work', 'payload'].every(
          (key) => Object.hasOwn(input, key),
        ) ||
        input.v !== 1 ||
        typeof input.type !== 'string' ||
        input.type.length > 128 ||
        !/^[a-z0-9_.-]{1,120}\.v[1-9][0-9]{0,5}$/.test(input.type) ||
        typeof input.occurred_at_ms !== 'number' ||
        !Number.isSafeInteger(input.occurred_at_ms) ||
        input.occurred_at_ms < 0 ||
        input.occurred_at_ms > 253402300799999
      ) {
        return err(invalid());
      }

      object(input.payload);
      const id = valueOf(parse(string(input.id)));
      const work = workIn(input.work);
      const normalized = Buffer.from(
        JSON.stringify({ ...input, id, work: workOut(work) }),
      );

      return normalized.byteLength > 65536
        ? err(invalid())
        : ok(
            new Envelope(
              id,
              Uint8Array.from(normalized),
              work,
              input.type,
              input.occurred_at_ms,
            ),
          );
    } catch {
      return err(invalid());
    }
  }
}

export { assertEventWork } from './provenance.js';

export type Receipt = {
  eventId: ID;
  durable: boolean;
};

/** Dispatcher-owned delivery capability with explicit cancellation. */
export interface Publisher {
  publish(
    event: Envelope,
    signal?: AbortSignal,
  ): Promise<Result<Receipt, Failure>>;
}
