import { createConnection, type Socket } from 'node:net';
import { SecretString } from '../../../../shared/secret/index.js';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type { Digest } from '../../../../shared/keyed/index.js';
import type {
  Admission,
  AttemptLimiter,
  Clock,
} from '../../app/command/index.js';

export interface RedisLimiterConfig {
  readonly url: SecretString;
  readonly timeoutMs: number;
  readonly maxKeys: number;
}
const dependency = (): Failure =>
  failure('unavailable', 'authentication dependency failed', {
    type: 'identity.auth_dependency_failed',
  });
const configuration = (): Failure =>
  failure('invalid', 'invalid Redis limiter configuration', {
    type: 'identity.limiter_configuration',
  });
const SCRIPT = `
local now = tonumber(ARGV[1])
local max_keys = tonumber(ARGV[2])
local n = tonumber(ARGV[3])
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)
for _, field in ipairs(expired) do
  redis.call('ZREM', KEYS[1], field)
  redis.call('HDEL', KEYS[2], field)
end
local new = 0
for i = 0, n - 1 do
  local field = ARGV[4 + i * 3]
  if not redis.call('ZSCORE', KEYS[1], field) then
    local duplicate = 0
    for j = 0, i - 1 do
      if ARGV[4 + j * 3] == field then duplicate = 1 break end
    end
    if duplicate == 0 then new = new + 1 end
  end
end
if redis.call('ZCARD', KEYS[1]) + new > max_keys then
  return redis.error_reply('LIMITER_FULL')
end
local denied = 0
local retry = 0
for i = 0, n - 1 do
  local base = 4 + i * 3
  local field = ARGV[base]
  local attempts = tonumber(ARGV[base + 1])
  local window = tonumber(ARGV[base + 2])
  local end_ms = redis.call('ZSCORE', KEYS[1], field)
  if not end_ms then
    end_ms = now + window
    redis.call('ZADD', KEYS[1], end_ms, field)
    redis.call('HSET', KEYS[2], field, 0)
  end
  local count = redis.call('HINCRBY', KEYS[2], field, 1)
  if count > attempts then
    denied = 1
    local remaining = end_ms - now
    if remaining > retry then retry = remaining end
  end
end
return {denied == 0 and 1 or 0, retry}`;

type Endpoint = {
  readonly host: string;
  readonly port: number;
  readonly password?: string;
  readonly username?: string;
  readonly database: number;
};
type Reply =
  | { readonly kind: 'simple' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'integer'; readonly value: number }
  | { readonly kind: 'array'; readonly value: readonly Reply[] };

function parseEndpoint(raw: string): Result<Endpoint, Failure> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return err(configuration());
  }
  if (
    parsed.protocol !== 'redis:' ||
    parsed.hostname === '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    return err(configuration());
  const port = parsed.port === '' ? 6379 : Number(parsed.port);
  const path =
    parsed.pathname === '/' || parsed.pathname === ''
      ? ''
      : parsed.pathname.slice(1);
  const database = path === '' ? 0 : Number(path);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isInteger(database) ||
    database < 0 ||
    database > 15 ||
    (parsed.username !== '' && parsed.password === '')
  )
    return err(configuration());
  return ok({
    host: parsed.hostname,
    port,
    ...(parsed.password !== ''
      ? {
          password: parsed.password,
          ...(parsed.username ? { username: parsed.username } : {}),
        }
      : {}),
    database,
  });
}
function encode(args: readonly string[]): Buffer {
  return Buffer.from(
    '*' +
      args.length +
      '\r\n' +
      args
        .map(
          (arg) =>
            '$' + Buffer.byteLength(arg) + '\r\n' + arg + '\r\n',
        )
        .join(''),
    'utf8',
  );
}
function parseReply(data: Buffer, offset = 0): [Reply, number] | undefined {
  const kind = String.fromCharCode(data[offset] ?? 0);
  const end = data.indexOf('\r\n', offset + 1);
  if (end < 0) return undefined;
  const line = data.subarray(offset + 1, end).toString('utf8');
  if (kind === '+' || kind === '-')
    return [
      kind === '+'
        ? { kind: 'simple' }
        : { kind: 'error', message: line },
      end + 2,
    ];
  if (kind === ':') {
    const value = Number(line);
    return Number.isSafeInteger(value)
      ? [{ kind: 'integer', value }, end + 2]
      : undefined;
  }
  if (kind === '*') {
    const count = Number(line);
    if (!Number.isSafeInteger(count) || count < 0 || count > 16)
      return undefined;
    const values: Reply[] = [];
    let cursor = end + 2;
    for (let i = 0; i < count; i++) {
      const parsed = parseReply(data, cursor);
      if (!parsed) return undefined;
      values.push(parsed[0]);
      cursor = parsed[1];
    }
    return [{ kind: 'array', value: values }, cursor];
  }
  return undefined;
}
function send(
  socket: Socket,
  args: readonly string[],
  timeoutMs: number,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('redis timeout'));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      data = Buffer.concat([data, chunk]);
      const parsed = parseReply(data);
      if (!parsed) return;
      clearTimeout(timer);
      socket.off('data', onData);
      resolve(parsed[0]);
    };
    socket.on('data', onData);
    socket.write(encode(args), (error) => {
      if (!error) return;
      clearTimeout(timer);
      socket.off('data', onData);
      reject(error);
    });
  });
}
async function call(
  endpoint: Endpoint,
  commands: readonly (readonly string[])[],
  timeoutMs: number,
): Promise<readonly Reply[]> {
  const socket = createConnection({ host: endpoint.host, port: endpoint.port });
  socket.setTimeout(timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
      socket.once('timeout', () => reject(new Error('redis timeout')));
    });
    const replies: Reply[] = [];
    for (const command of commands)
      replies.push(await send(socket, command, timeoutMs));
    return replies;
  } finally {
    socket.destroy();
  }
}
const subjectAttempts = (operation: string): number | undefined =>
  ({
    register: 5,
    login: 10,
    verification_request: 3,
    reset_request: 3,
    verify: 10,
    reset: 10,
    password_change: 5,
  })[operation];
const sourceAttempts = (operation: string): number | undefined =>
  ({ register: 30, login: 100, verification_request: 30, reset_request: 30 })[
    operation
  ];

export class RedisLimiter implements AttemptLimiter {
  readonly #endpoint: Endpoint;
  readonly #keyed: Digest;
  readonly #clock: Clock;
  readonly #timeoutMs: number;
  readonly #maxKeys: number;
  private constructor(
    endpoint: Endpoint,
    keyed: Digest,
    clock: Clock,
    timeoutMs: number,
    maxKeys: number,
  ) {
    this.#endpoint = endpoint;
    this.#keyed = keyed;
    this.#clock = clock;
    this.#timeoutMs = timeoutMs;
    this.#maxKeys = maxKeys;
    Object.freeze(this);
  }
  static create(
    keyed: Digest,
    clock: Clock,
    config: RedisLimiterConfig,
  ): Result<RedisLimiter, Failure> {
    if (
      !keyed ||
      !clock ||
      !Number.isSafeInteger(config.timeoutMs) ||
      config.timeoutMs < 1 ||
      !Number.isSafeInteger(config.maxKeys) ||
      config.maxKeys < 1 ||
      !(config.url instanceof SecretString)
    )
      return err(configuration());
    const endpoint = parseEndpoint(config.url.reveal());
    return endpoint.ok
      ? ok(
          new RedisLimiter(
            endpoint.value,
            keyed,
            clock,
            config.timeoutMs,
            config.maxKeys,
          ),
        )
      : endpoint;
  }
  async admit(
    operation: string,
    subject: SecretString,
    source: string,
  ): Promise<Result<Admission, Failure>> {
    const attempts = subjectAttempts(operation);
    if (!attempts) return err(dependency());
    let now: number;
    try {
      now = this.#clock.now().getTime();
    } catch {
      return err(dependency());
    }
    if (!Number.isSafeInteger(now) || now < 0) return err(dependency());
    const signed = this.#keyed.sign(
      'rate_limit',
      Buffer.from(operation + '\0' + subject.reveal(), 'utf8'),
    );
    if (!signed.ok) return err(dependency());
    const fields: string[] = [
      Buffer.from(signed.value).toString('hex'),
      String(attempts),
      String(15 * 60_000),
    ];
    const sourceLimit = sourceAttempts(operation);
    if (sourceLimit && source !== '') {
      const sourceKey = this.#keyed.sign(
        'rate_limit',
        Buffer.from(operation + '\0' + source, 'utf8'),
      );
      if (!sourceKey.ok) return err(dependency());
      fields.push(
        Buffer.from(sourceKey.value).toString('hex'),
        String(sourceLimit),
        String(15 * 60_000),
      );
    }
    const commands: (readonly string[])[] = [];
    if (this.#endpoint.password)
      commands.push(
        this.#endpoint.username
          ? ['AUTH', this.#endpoint.username, this.#endpoint.password]
          : ['AUTH', this.#endpoint.password],
      );
    if (this.#endpoint.database !== 0)
      commands.push(['SELECT', String(this.#endpoint.database)]);
    commands.push([
      'EVAL',
      SCRIPT,
      '2',
      '{n2f-limiter}:index',
      '{n2f-limiter}:counts',
      String(now),
      String(this.#maxKeys),
      String(fields.length / 3),
      ...fields,
    ]);
    try {
      const replies = await call(this.#endpoint, commands, this.#timeoutMs);
      const reply = replies.at(-1);
      if (reply?.kind === 'error') return err(dependency());
      if (
        reply?.kind !== 'array' ||
        reply.value.length !== 2 ||
        reply.value[0]?.kind !== 'integer' ||
        reply.value[1]?.kind !== 'integer' ||
        reply.value[1].value < 0
      )
        return err(dependency());
      return reply.value[0].value === 1
        ? ok({ permitted: true })
        : reply.value[0].value === 0
          ? ok({ permitted: false, retryAfterMs: reply.value[1].value })
          : err(dependency());
    } catch {
      return err(dependency());
    }
  }
}
