/** Concrete JetStream adapter; domains depend only on the Publisher seam. */
import {
  connect,
  headers,
  type Msg,
  type MsgHdrs,
  type NatsConnection,
} from '@nats-io/transport-node';
import { isDeepStrictEqual } from 'node:util';
import { SecretString } from '../../secret/index.js';
import {
  AppError,
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../errors/index.js';
import { Envelope, type Publisher, type Receipt } from '../index.js';

export type Config = {
  url: SecretString;
  stream: string;
  consumer: string;
  timeoutMs: number;
  /** Target defaults to n2f.events.; legacy deployments can override it. */
  subjectPrefix?: string;
  consumerDeliverPolicy?: 'all' | 'new';
};

const DEFAULT_SUBJECT_PREFIX = 'n2f.events.';
const SUBJECT_PREFIX_PATTERN = /^[A-Za-z0-9_]{1,40}\.[A-Za-z0-9_]{1,40}\.$/;

const unavailable = () =>
  failure('unavailable', 'JetStream operation incomplete', {
    type: 'events.jetstream_unavailable',
  });
const invalid = () =>
  failure('invalid', 'invalid JetStream configuration', {
    type: 'events.jetstream_config',
  });

function value<T>(result: Result<T, Failure>): T {
  if (!result.ok) throw new AppError(result.error);
  return result.value;
}

function compatible(
  got: Record<string, unknown>,
  want: Record<string, unknown>,
): boolean {
  return (
    !!got &&
    Object.entries(want).every(([key, expected]) =>
      isDeepStrictEqual(got[key], expected),
    )
  );
}

export class Broker implements Publisher {
  readonly #subject: string;

  private constructor(
    private readonly connection: NatsConnection,
    private readonly config: Config,
  ) {
    this.#subject =
      (config.subjectPrefix ?? DEFAULT_SUBJECT_PREFIX) + config.stream;
  }

  static async open(config: Config): Promise<Result<Broker, Failure>> {
    try {
      const url = new URL(config.url.reveal());
      if (
        !['nats:', 'tls:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname ||
        !/^[A-Za-z0-9_]{1,40}$/.test(config.stream) ||
        !/^[A-Za-z0-9_]{1,40}$/.test(config.consumer) ||
        (config.subjectPrefix !== undefined &&
          !SUBJECT_PREFIX_PATTERN.test(config.subjectPrefix)) ||
        !Number.isInteger(config.timeoutMs) ||
        config.timeoutMs < 1 ||
        config.timeoutMs > 5000
      ) {
        return err(invalid());
      }
    } catch {
      return err(invalid());
    }

    try {
      const connection = await connect({
        servers: config.url.reveal(),
        timeout: config.timeoutMs,
        reconnect: true,
        maxReconnectAttempts: -1,
        reconnectTimeWait: Math.min(2000, Math.max(250, config.timeoutMs)),
      });
      return ok(new Broker(connection, { ...config }));
    } catch {
      return err(unavailable());
    }
  }

  async close(): Promise<void> {
    await this.connection.close();
  }

  ping(caller?: AbortSignal): Promise<Result<void, Failure>> {
    return this.operation(async (signal) => {
      const info = await this.api('$JS.API.INFO', {}, signal);
      if (info.error) throw new AppError(unavailable());
    }, caller);
  }

  private async operation<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    caller?: AbortSignal,
  ): Promise<Result<T, Failure>> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.config.timeoutMs);
    const signal = caller
      ? AbortSignal.any([caller, deadline.signal])
      : deadline.signal;
    try {
      return ok(await fn(signal));
    } catch (error) {
      return err(
        caller?.aborted
          ? failure('canceled', 'JetStream operation canceled')
          : error instanceof AppError
            ? error.failure
            : unavailable(),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(
    subject: string,
    data: Uint8Array,
    signal: AbortSignal,
    messageHeaders?: MsgHdrs,
  ): Promise<Msg> {
    signal.throwIfAborted();
    let onAbort!: () => void;
    try {
      const message = await Promise.race([
        this.connection.request(subject, data, {
          timeout: this.config.timeoutMs,
          noMux: true,
          headers: messageHeaders,
        }),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error('canceled'));
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      if (message.data.length > 131072) throw new AppError(unavailable());
      return message;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async api(
    subject: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const message = await this.request(
      subject,
      Buffer.from(JSON.stringify(input)),
      signal,
    );
    const output: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(message.data),
    );
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
      throw new AppError(unavailable());
    }
    return output as Record<string, unknown>;
  }

  provision(caller?: AbortSignal): Promise<Result<void, Failure>> {
    return this.operation(async (signal) => {
      const stream = {
        name: this.config.stream,
        subjects: [this.#subject],
        storage: 'file',
        num_replicas: 1,
        retention: 'limits',
        discard: 'new',
        max_bytes: 67108864,
        max_msg_size: 131072,
        duplicate_window: 120000000000,
      };
      let info = await this.api(
        '$JS.API.STREAM.INFO.' + this.config.stream,
        {},
        signal,
      );
      if (info.error && (info.error as Record<string, unknown>).code === 404) {
        info = await this.api(
          '$JS.API.STREAM.CREATE.' + this.config.stream,
          stream,
          signal,
        );
      }
      if (info.error || !compatible(info.config as Record<string, unknown>, stream)) {
        throw new AppError(info.error ? unavailable() : invalid());
      }
      const consumer = {
        durable_name: this.config.consumer,
        ack_policy: 'explicit',
        ack_wait: 1000000000,
        max_deliver: 5,
        max_ack_pending: 1,
        filter_subject: this.#subject,
        deliver_policy: this.config.consumerDeliverPolicy ?? 'all',
        replay_policy: 'instant',
      };
      info = await this.api(
        '$JS.API.CONSUMER.INFO.' +
          this.config.stream +
          '.' +
          this.config.consumer,
        {},
        signal,
      );
      if (info.error && (info.error as Record<string, unknown>).code === 404) {
        info = await this.api(
          '$JS.API.CONSUMER.DURABLE.CREATE.' +
            this.config.stream +
            '.' +
            this.config.consumer,
          { stream_name: this.config.stream, config: consumer },
          signal,
        );
      }
      if (info.error || !compatible(info.config as Record<string, unknown>, consumer)) {
        throw new AppError(info.error ? unavailable() : invalid());
      }
    }, caller);
  }

  publish(
    event: Envelope,
    caller?: AbortSignal,
  ): Promise<Result<Receipt, Failure>> {
    return this.operation(async (signal) => {
      const messageHeaders = headers();
      messageHeaders.set('Nats-Msg-Id', event.id);
      messageHeaders.set('Nats-Expected-Stream', this.config.stream);
      const message = await this.request(
        this.#subject,
        event.bytes(),
        signal,
        messageHeaders,
      );
      const ack: unknown = JSON.parse(new TextDecoder().decode(message.data));
      if (
        !ack ||
        typeof ack !== 'object' ||
        Array.isArray(ack) ||
        (ack as Record<string, unknown>).error ||
        (ack as Record<string, unknown>).stream !== this.config.stream ||
        !Number.isSafeInteger((ack as Record<string, unknown>).seq) ||
        ((ack as Record<string, unknown>).seq as number) <= 0
      ) {
        throw new AppError(unavailable());
      }
      const receipt = ack as Record<string, unknown>;
      if (receipt.duplicate) {
        const stored = await this.api(
          '$JS.API.STREAM.MSG.GET.' + this.config.stream,
          { seq: receipt.seq },
          signal,
        );
        const messageData = (stored.message as Record<string, unknown> | undefined)
          ?.data;
        if (typeof messageData !== 'string') throw new AppError(unavailable());
        const original = JSON.parse(
          Buffer.from(messageData, 'base64').toString('utf8'),
        );
        if (
          !isDeepStrictEqual(
            original,
            JSON.parse(Buffer.from(event.bytes()).toString('utf8')),
          )
        ) {
          throw new AppError(
            failure('conflict', 'event delivery conflict', {
              type: 'events.id_reused',
            }),
          );
        }
      }
      return { eventId: event.id, durable: true };
    }, caller);
  }

  transfer(
    sink: Publisher,
    caller?: AbortSignal,
  ): Promise<Result<boolean, Failure>> {
    return this.operation(async (signal) => {
      const message = await this.request(
        '$JS.API.CONSUMER.MSG.NEXT.' +
          this.config.stream +
          '.' +
          this.config.consumer,
        Buffer.from('{"batch":1,"no_wait":true}'),
        signal,
      );
      if ([404, 408].includes(message.headers?.code ?? 0)) return false;
      if (!message.reply) throw new AppError(unavailable());
      const event = value(Envelope.decode(message.data));
      const receipt = value(await sink.publish(event, signal));
      if (!receipt.durable || receipt.eventId !== event.id) {
        throw new AppError(unavailable());
      }
      await this.request(message.reply, Buffer.from('+ACK'), signal);
      return true;
    }, caller);
  }
}
